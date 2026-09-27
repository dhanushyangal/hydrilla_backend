/**
 * `image.rembg` — reference admission before any paid image→3D call.
 *
 * The point of this stage is money: a cluttered or tiny reference produces a bad mesh, and
 * we would rather reject the image for free than spend a GPU job discovering it. So every
 * path here fails closed — an image we cannot measure is never admitted.
 *
 * Floors: ../create/quality/thresholds.ts (ADMISSION)
 * Spec: agent-skills/.../skills/cloud/cloud-preprocess-ref/SKILL.md
 *       .../references/i2-3d-intake.md
 */

import type { FailCode } from "./contracts.js";
import { decodePng, PngDecodeError } from "./mesh/png.js";
import { ADMISSION } from "./quality/thresholds.js";

export type ForegroundMask = {
  mask: Uint8Array;
  width: number;
  height: number;
};

/**
 * A background-removal backend (BiRefNet in production). Returns a foreground mask.
 * Left as an interface so the evaluator has no implicit dependency on a running service.
 */
export type RembgAdapter = (input: {
  bytes: Buffer;
  contentType: string;
}) => Promise<{ available: true; mask: ForegroundMask } | { available: false; reason: string }>;

/** The default. No matting service means we only admit what we can measure locally. */
export const unavailableRembg: RembgAdapter = async () => ({
  available: false,
  reason: "No BiRefNet/rembg adapter is configured for this deployment.",
});

export type AdmissionReport = {
  admitted: boolean;
  /** How the mask was obtained. Provenance is required for evidence. */
  maskSource: "rembg_adapter" | "png_alpha" | "png_background_estimate" | "none";
  width: number;
  height: number;
  /** Foreground pixels / total pixels. */
  foregroundRatio: number | null;
  /** Largest connected foreground blob / total foreground. */
  largestBlobRatio: number | null;
  shortSidePx: number | null;
  failCodes: FailCode[];
  reasons: string[];
  /** Retained in-process for Tier1; not persisted in the report. */
  mask: ForegroundMask | null;
};

/**
 * Measure an image against the admission floors.
 *
 * Mask precedence: a configured matting adapter, then a PNG alpha channel, then a
 * background-colour estimate for opaque PNGs. Anything else (JPEG, palette PNG, 16-bit)
 * is not admitted — guessing at a foreground would defeat the purpose of the gate.
 */
export async function admitReference(params: {
  bytes: Buffer;
  contentType?: string;
  rembg?: RembgAdapter;
}): Promise<AdmissionReport> {
  const reasons: string[] = [];
  const failCodes: FailCode[] = [];
  const contentType = params.contentType ?? "application/octet-stream";

  let mask: ForegroundMask | null = null;
  let maskSource: AdmissionReport["maskSource"] = "none";

  const adapter = params.rembg ?? unavailableRembg;
  const adapterResult = await adapter({ bytes: params.bytes, contentType });
  if (adapterResult.available) {
    mask = adapterResult.mask;
    maskSource = "rembg_adapter";
  } else {
    reasons.push(`rembg adapter unavailable (${adapterResult.reason}); falling back to local analysis.`);
    try {
      const decoded = decodePng(params.bytes);
      if (decoded.channels === 4 || decoded.channels === 2) {
        mask = maskFromAlpha(decoded);
        maskSource = "png_alpha";
      } else {
        mask = maskFromBackgroundEstimate(decoded);
        maskSource = "png_background_estimate";
        reasons.push(
          "No alpha channel; foreground estimated from border colour. A matting adapter gives a better mask."
        );
      }
    } catch (err) {
      const detail = err instanceof PngDecodeError ? err.message : String(err);
      failCodes.push("BAD_SILHOUETTE");
      reasons.push(
        `Cannot measure this image locally (${detail}). Admission fails closed — configure a rembg adapter or supply an 8-bit PNG.`
      );
      return {
        admitted: false,
        maskSource: "none",
        width: 0,
        height: 0,
        foregroundRatio: null,
        largestBlobRatio: null,
        shortSidePx: null,
        failCodes,
        reasons,
        mask: null,
      };
    }
  }

  const { width, height } = mask;
  const shortSidePx = Math.min(width, height);
  if (shortSidePx < ADMISSION.minShortSidePx) {
    failCodes.push("ADMISSION_SIZE");
    reasons.push(`Short side ${shortSidePx}px is below the ${ADMISSION.minShortSidePx}px floor.`);
  }

  let foreground = 0;
  for (let i = 0; i < mask.mask.length; i++) if (mask.mask[i]) foreground++;
  const foregroundRatio = mask.mask.length > 0 ? foreground / mask.mask.length : 0;

  if (foregroundRatio < ADMISSION.minForegroundRatio) {
    failCodes.push("ADMISSION_FG");
    reasons.push(
      `Foreground is ${(foregroundRatio * 100).toFixed(1)}% of frame, below the ${ADMISSION.minForegroundRatio * 100}% floor — the subject is too small or the mask is empty.`
    );
  } else if (foregroundRatio > ADMISSION.maxForegroundRatio) {
    failCodes.push("ADMISSION_FG");
    reasons.push(
      `Foreground is ${(foregroundRatio * 100).toFixed(1)}% of frame, above the ${ADMISSION.maxForegroundRatio * 100}% ceiling — the subject is cropped or the background was not removed.`
    );
  }

  const largestBlob = largestBlobSize(mask);
  const largestBlobRatio = foreground > 0 ? largestBlob / foreground : 0;
  if (foreground > 0 && largestBlobRatio < ADMISSION.minLargestBlobRatio) {
    failCodes.push("ADMISSION_BLOB");
    reasons.push(
      `Largest blob is ${(largestBlobRatio * 100).toFixed(1)}% of the foreground, below the ${ADMISSION.minLargestBlobRatio * 100}% floor — the frame holds more than one subject.`
    );
  }

  return {
    admitted: failCodes.length === 0,
    maskSource,
    width,
    height,
    foregroundRatio,
    largestBlobRatio,
    shortSidePx,
    failCodes,
    reasons,
    mask,
  };
}

/** Alpha above half is foreground. */
function maskFromAlpha(decoded: {
  width: number;
  height: number;
  channels: number;
  pixels: Uint8Array;
}): ForegroundMask {
  const { width, height, channels, pixels } = decoded;
  const alphaOffset = channels - 1;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = pixels[i * channels + alphaOffset]! > 127 ? 1 : 0;
  }
  return { mask, width, height };
}

/**
 * Estimate foreground for an opaque image by flood-filling from the border in the
 * background colour. Deliberately conservative: only near-uniform studio backgrounds get
 * removed, which matches the "plain BG only" intake rule.
 */
function maskFromBackgroundEstimate(decoded: {
  width: number;
  height: number;
  channels: number;
  pixels: Uint8Array;
}): ForegroundMask {
  const { width, height, channels, pixels } = decoded;
  const sample = (index: number): [number, number, number] => {
    const at = index * channels;
    return channels >= 3
      ? [pixels[at]!, pixels[at + 1]!, pixels[at + 2]!]
      : [pixels[at]!, pixels[at]!, pixels[at]!];
  };

  // Median border colour is the background estimate.
  const borderSamples: Array<[number, number, number]> = [];
  for (let x = 0; x < width; x++) {
    borderSamples.push(sample(x));
    borderSamples.push(sample((height - 1) * width + x));
  }
  for (let y = 0; y < height; y++) {
    borderSamples.push(sample(y * width));
    borderSamples.push(sample(y * width + width - 1));
  }
  const background: [number, number, number] = [
    median(borderSamples.map((s) => s[0])),
    median(borderSamples.map((s) => s[1])),
    median(borderSamples.map((s) => s[2])),
  ];

  const TOLERANCE = 28;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const [r, g, b] = sample(i);
    const distance = Math.abs(r - background[0]) + Math.abs(g - background[1]) + Math.abs(b - background[2]);
    mask[i] = distance > TOLERANCE ? 1 : 0;
  }
  return { mask, width, height };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** Largest 4-connected foreground component, by pixel count. Iterative — no stack overflow. */
export function largestBlobSize(mask: ForegroundMask): number {
  const { width, height } = mask;
  const seen = new Uint8Array(width * height);
  const stack: number[] = [];
  let largest = 0;

  for (let start = 0; start < mask.mask.length; start++) {
    if (!mask.mask[start] || seen[start]) continue;
    let size = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const at = stack.pop()!;
      size++;
      const x = at % width;
      const y = (at - x) / width;
      if (x > 0) pushIf(at - 1);
      if (x < width - 1) pushIf(at + 1);
      if (y > 0) pushIf(at - width);
      if (y < height - 1) pushIf(at + width);
    }
    if (size > largest) largest = size;
  }

  function pushIf(index: number) {
    if (mask.mask[index] && !seen[index]) {
      seen[index] = 1;
      stack.push(index);
    }
  }

  return largest;
}
