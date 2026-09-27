/**
 * Interior difference — img2threejs `interior_difference.py` fold.
 *
 * Silhouette IoU only sees outline cells. A finished face and the same model with
 * the face deleted can score identically. This measures the interior of the
 * silhouette, banded by height, and refuses to score when too few cells compare.
 */

export type InteriorInput = {
  mask: Uint8Array;
  width: number;
  height: number;
  /** Optional Lambert shade; used when both sides have it. */
  shade?: Uint8Array | null;
};

export type InteriorResult = {
  score: number | null;
  cellsCompared: number;
  passed: boolean;
  notes: string[];
};

const BANDS = 8;
const MIN_CELLS = 40;
const PASS_FLOOR = 0.62;

function isOutline(mask: Uint8Array, width: number, height: number, x: number, y: number): boolean {
  if (!mask[y * width + x]) return false;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) return true;
      if (!mask[ny * width + nx]) return true;
    }
  }
  return false;
}

function resample(
  src: InteriorInput,
  size: number
): { mask: Uint8Array; shade: Uint8Array | null } {
  const mask = new Uint8Array(size * size);
  const shade = src.shade ? new Uint8Array(size * size) : null;
  for (let y = 0; y < size; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y / size) * src.height));
    for (let x = 0; x < size; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x / size) * src.width));
      const i = y * size + x;
      mask[i] = src.mask[sy * src.width + sx] ? 1 : 0;
      if (shade && src.shade) shade[i] = src.shade[sy * src.width + sx]!;
    }
  }
  return { mask, shade };
}

/**
 * Compare candidate vs reference interiors. When no reference is supplied, score
 * interior fill (eroded coverage) so a hollow outline cannot pass as a volume.
 */
export function interiorDifference(
  candidate: InteriorInput,
  reference: InteriorInput | null
): InteriorResult {
  const notes: string[] = [];
  const size = 96;
  const cand = resample(candidate, size);

  if (!reference) {
    let fg = 0;
    let inner = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (!cand.mask[i]) continue;
        fg++;
        if (!isOutline(cand.mask, size, size, x, y)) inner++;
      }
    }
    if (fg < MIN_CELLS) {
      notes.push(`Interior fill unevaluated — only ${fg} foreground cells.`);
      return { score: null, cellsCompared: fg, passed: false, notes };
    }
    const fill = inner / fg;
    const passed = fill >= 0.45;
    notes.push(`No reference; interior fill ${fill.toFixed(3)} over ${fg} cells (outline excluded).`);
    return { score: fill, cellsCompared: fg, passed, notes };
  }

  const ref = resample(reference, size);
  let cells = 0;
  let mismatch = 0;
  let shadeDiff = 0;
  let shadeCells = 0;

  for (let band = 0; band < BANDS; band++) {
    const y0 = Math.floor((band / BANDS) * size);
    const y1 = Math.floor(((band + 1) / BANDS) * size);
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const a = cand.mask[i] === 1;
        const b = ref.mask[i] === 1;
        if (!a && !b) continue;
        if (a && isOutline(cand.mask, size, size, x, y) && !b) continue;
        if (b && isOutline(ref.mask, size, size, x, y) && !a) continue;
        cells++;
        if (a !== b) mismatch++;
        else if (a && b && cand.shade && ref.shade) {
          shadeDiff += Math.abs(cand.shade[i]! - ref.shade[i]!) / 255;
          shadeCells++;
        }
      }
    }
  }

  if (cells < MIN_CELLS) {
    notes.push(`Interior difference unevaluated — only ${cells} interior cells compared.`);
    return { score: null, cellsCompared: cells, passed: false, notes };
  }

  let score = 1 - mismatch / cells;
  if (shadeCells > MIN_CELLS) {
    const shadeAgree = 1 - shadeDiff / shadeCells;
    score = score * 0.7 + shadeAgree * 0.3;
  }
  const passed = score >= PASS_FLOOR;
  notes.push(
    `Interior difference ${score.toFixed(3)} over ${cells} cells across ${BANDS} height bands (floor ${PASS_FLOOR}).`
  );
  return { score, cellsCompared: cells, passed, notes };
}
