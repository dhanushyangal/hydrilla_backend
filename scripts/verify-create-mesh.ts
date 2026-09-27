/**
 * Verifies the mesh gate spine: GLB parsing, geometry analysis, silhouette raster,
 * PNG codec, and `mesh.post.gate` fail-code classification.
 *
 * No DB, no network, no GPU. Every fixture is generated in memory.
 *
 *   npm run verify:mesh
 */

import { runMeshPostGate, hardFailCodes } from "../src/lib/create/mesh/gate.js";
import { parseGlb } from "../src/lib/create/mesh/glb.js";
import { analyseGeometry, computeBounds } from "../src/lib/create/mesh/geometry.js";
import {
  renderSilhouettes,
  silhouetteIou,
  objectness,
  summariseMask,
} from "../src/lib/create/mesh/silhouette.js";
import { encodePng, decodePng, composeComparisonSheet } from "../src/lib/create/mesh/png.js";
import { TURNTABLE_ANGLES } from "../src/lib/create/quality/thresholds.js";
import type { FailCode } from "../src/lib/create/contracts.js";
import {
  buildEmptyGlb,
  buildGlb,
  makeBox,
  makePlane,
  mergeMeshes,
  translate,
  type MeshData,
} from "./fixtures/glbFixtures.js";

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
  } else {
    failures.push(detail ? `${label} — ${detail}` : label);
  }
}

function expectCodes(label: string, codes: FailCode[], expected: FailCode[], forbidden: FailCode[] = []) {
  for (const code of expected) {
    check(`${label}: emits ${code}`, codes.includes(code), `got [${codes.join(", ") || "none"}]`);
  }
  for (const code of forbidden) {
    check(`${label}: does not emit ${code}`, !codes.includes(code), `got [${codes.join(", ")}]`);
  }
}

const GOOD_PROP = { engine: "cloud" as const, profile: "balanced" as const, assetClass: "prop" as const };

// ---------------------------------------------------------------------------
// 1. Parser
// ---------------------------------------------------------------------------
{
  const glb = buildGlb(makeBox({ min: [0, 0, 0], max: [1, 1, 1] }));
  const parsed = parseGlb(glb);
  check("parser: reads one primitive", parsed.primitives.length === 1);
  check("parser: 12 triangles for a unit box", parsed.triangleCount === 12, `got ${parsed.triangleCount}`);
  check("parser: reads normals", parsed.primitives[0]!.normals !== null);
  check("parser: reads UVs", parsed.primitives[0]!.hasUv);
  check("parser: reads material", parsed.materials.length === 1 && parsed.materials[0]!.name === "body");
  check("parser: reads node name", parsed.nodeNames.includes("subject"));

  const bounds = computeBounds(parsed);
  check("parser: finite bounds", bounds.finite);
  check("parser: unit size", Math.abs(bounds.size[0] - 1) < 1e-6 && Math.abs(bounds.size[1] - 1) < 1e-6);
}

// Node transforms must be applied, otherwise grounding and scale are meaningless.
{
  const box = makeBox({ min: [0, 0, 0], max: [1, 1, 1] });
  const glb = buildGlb(box);
  const json = JSON.parse(
    glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8").replace(/\s+$/, "")
  );
  json.nodes[0].scale = [2, 2, 2];
  json.nodes[0].translation = [0, 3, 0];
  // Rebuild with the mutated JSON, reusing the original BIN chunk.
  const jsonChunkLength = glb.readUInt32LE(12);
  const binStart = 20 + jsonChunkLength + 8;
  const binLength = glb.readUInt32LE(20 + jsonChunkLength);
  const bin = glb.subarray(binStart, binStart + binLength);
  const { packGlb } = await import("./fixtures/glbFixtures.js");
  const transformed = parseGlb(packGlb(json, bin));
  const bounds = computeBounds(transformed);
  check(
    "parser: applies node scale",
    Math.abs(bounds.size[0] - 2) < 1e-5,
    `size.x = ${bounds.size[0]}`
  );
  check(
    "parser: applies node translation",
    Math.abs(bounds.min[1] - 3) < 1e-5,
    `min.y = ${bounds.min[1]}`
  );
}

// ---------------------------------------------------------------------------
// 2. Geometry analysis
// ---------------------------------------------------------------------------
{
  const parsed = parseGlb(buildGlb(makeBox({ min: [0, 0, 0], max: [1, 1, 1] })));
  const stats = analyseGeometry(parsed);
  check("geometry: closed box has 0 non-manifold edges", stats.nonManifoldEdges === 0, `got ${stats.nonManifoldEdges}`);
  check("geometry: closed box has 0 boundary edges", stats.boundaryEdges === 0, `got ${stats.boundaryEdges}`);
  check("geometry: unit box volume ≈ 1", Math.abs(stats.volume - 1) < 1e-6, `got ${stats.volume}`);
  check("geometry: one component", stats.components.length === 1, `got ${stats.components.length}`);
  check("geometry: no self-intersection", stats.selfIntersectingPairs === 0);
  check("geometry: scan not truncated", !stats.selfIntersectionTruncated);
  check("geometry: normals agree with winding", stats.invertedNormalRatio === 0, `got ${stats.invertedNormalRatio}`);
}

// An open shell must report boundary edges and zero volume.
{
  const parsed = parseGlb(buildGlb(makePlane(1)));
  const stats = analyseGeometry(parsed);
  check("geometry: plane has boundary edges", stats.boundaryEdges === 4, `got ${stats.boundaryEdges}`);
  check("geometry: plane volume is 0", stats.volume < 1e-9, `got ${stats.volume}`);
}

// Three triangles on one edge is the canonical non-manifold case.
{
  const box = makeBox({ min: [0, 0, 0], max: [1, 1, 1] });
  const fin: MeshData = {
    // Shares the edge (0,0,0)-(1,0,0) with the box, adding a third face on it.
    positions: [0, 0, 0, 1, 0, 0, 0.5, 0.5, -1],
    indices: [0, 1, 2],
    normals: [0, 0, -1, 0, 0, -1, 0, 0, -1],
    uvs: [0, 0, 1, 0, 0.5, 1],
  };
  const stats = analyseGeometry(parseGlb(buildGlb(mergeMeshes(box, fin))));
  check("geometry: detects non-manifold edge", stats.nonManifoldEdges >= 1, `got ${stats.nonManifoldEdges}`);
}

// Two overlapping boxes: each closed, but their faces pass through each other.
// The offset is deliberately not a clean fraction — an exactly aligned overlap lands every
// crossing on a triangle edge, which the gate correctly treats as flush contact.
{
  const a = makeBox({ min: [0, 0, 0], max: [1, 1, 1] });
  const b = translate(makeBox({ min: [0, 0, 0], max: [1, 1, 1] }), 0.37, 0, 0.41);
  const stats = analyseGeometry(parseGlb(buildGlb(mergeMeshes(a, b))));
  check("geometry: detects self-intersection", stats.selfIntersectingPairs > 0, `got ${stats.selfIntersectingPairs}`);
  check("geometry: counts two components", stats.components.length === 2, `got ${stats.components.length}`);
}

// Adjacent-but-not-overlapping boxes must NOT be reported as intersecting.
{
  const a = makeBox({ min: [0, 0, 0], max: [1, 1, 1] });
  const b = translate(makeBox({ min: [0, 0, 0], max: [1, 1, 1] }), 2.5, 0, 0);
  const stats = analyseGeometry(parseGlb(buildGlb(mergeMeshes(a, b))));
  check("geometry: separated boxes do not self-intersect", stats.selfIntersectingPairs === 0, `got ${stats.selfIntersectingPairs}`);
}

// ---------------------------------------------------------------------------
// 3. Silhouette raster
// ---------------------------------------------------------------------------
{
  const parsed = parseGlb(buildGlb(makeBox({ min: [0, 0, 0], max: [1, 1, 1] })));
  const views = renderSilhouettes(parsed, computeBounds(parsed), TURNTABLE_ANGLES, 128);
  check("silhouette: four views", views.length === 4, `got ${views.length}`);
  check("silhouette: all views covered", views.every((v) => v.coveredPixels > 0));
  const widest = Math.max(...views.map((v) => v.coveredPixels));
  const ratios = views.map((v) => v.coveredPixels / widest);
  check("silhouette: box does not collapse at any angle", Math.min(...ratios) > 0.5, `min ratio ${Math.min(...ratios).toFixed(3)}`);
  check("silhouette: box is solid", views.every((v) => v.areaRatio > 0.9), `ratios ${views.map((v) => v.areaRatio.toFixed(2)).join(",")}`);
  check("silhouette: objectness high for a centred box", objectness(views[0]!) > 0.8, `got ${objectness(views[0]!).toFixed(3)}`);

  // A flat plane must collapse when viewed edge-on.
  const planeViews = renderSilhouettes(
    parseGlb(buildGlb(makePlane(1))),
    computeBounds(parseGlb(buildGlb(makePlane(1)))),
    TURNTABLE_ANGLES,
    128
  );
  const planeWidest = Math.max(...planeViews.map((v) => v.coveredPixels));
  const planeMin = Math.min(...planeViews.map((v) => v.coveredPixels / planeWidest));
  check("silhouette: plane collapses edge-on", planeMin < 0.15, `min ratio ${planeMin.toFixed(4)}`);

  // IoU is shape agreement, normalised for framing.
  check("silhouette: identical masks score IoU 1", silhouetteIou(views[0]!, views[0]!) > 0.99);
  const small = renderSilhouettes(
    parseGlb(buildGlb(makeBox({ min: [0, 0, 0], max: [0.2, 0.2, 0.2] }))),
    computeBounds(parseGlb(buildGlb(makeBox({ min: [0, 0, 0], max: [0.2, 0.2, 0.2] })))),
    [0],
    128
  );
  check(
    "silhouette: IoU ignores framing scale",
    silhouetteIou(views[0]!, small[0]!) > 0.95,
    `got ${silhouetteIou(views[0]!, small[0]!).toFixed(3)}`
  );
  check("silhouette: box vs plane IoU is low", silhouetteIou(views[1]!, planeViews[1]!) < 0.6);
}

// ---------------------------------------------------------------------------
// 4. PNG codec
// ---------------------------------------------------------------------------
{
  const width = 17; // deliberately not a multiple of 4
  const height = 9;
  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 7) % 256;

  const png = encodePng(pixels, width, height, "gray");
  check("png: signature", png.subarray(1, 4).toString("ascii") === "PNG");
  const decoded = decodePng(png);
  check("png: roundtrip dimensions", decoded.width === width && decoded.height === height);
  check("png: roundtrip greyscale channels", decoded.channels === 1);
  check(
    "png: roundtrip pixels are lossless",
    decoded.pixels.every((v, i) => v === pixels[i]),
    "pixel mismatch"
  );

  const rgb = new Uint8Array(width * height * 3).fill(120);
  const rgbDecoded = decodePng(encodePng(rgb, width, height, "rgb"));
  check("png: roundtrip rgb", rgbDecoded.channels === 3 && rgbDecoded.pixels[0] === 120);

  let rejected = false;
  try {
    decodePng(Buffer.from("not a png"));
  } catch {
    rejected = true;
  }
  check("png: rejects non-PNG input", rejected);

  const sheet = composeComparisonSheet([
    { label: "reference", width: 8, height: 8, pixels: new Uint8Array(64).fill(10) },
    { label: "candidate", width: 8, height: 8, pixels: new Uint8Array(64).fill(200) },
  ]);
  const sheetDecoded = decodePng(sheet);
  check("png: sheet width includes gap", sheetDecoded.width === 8 + 8 + 8, `got ${sheetDecoded.width}`);
  check("png: sheet has a label bar", sheetDecoded.height === 8 + 6, `got ${sheetDecoded.height}`);
}

// ---------------------------------------------------------------------------
// 5. mesh.post.gate — pass case
// ---------------------------------------------------------------------------
{
  const report = runMeshPostGate(
    buildGlb(makeBox({ min: [-0.25, 0, -0.25], max: [0.25, 0.5, 0.25] })),
    { ...GOOD_PROP, viewSize: 96 }
  );
  check("gate: clean grounded prop passes", report.passed, `findings: ${JSON.stringify(report.findings)}`);
  check("gate: no hard fail codes", hardFailCodes(report).length === 0);
  check("gate: records triangle count", report.measurements.triangleCount === 12);
  check("gate: records orbit ratio", (report.measurements.minOrbitAreaRatio ?? 0) > 0.15);
  check("gate: reports 4 views", report.views.length === 4);
  check("gate: full UV coverage", report.measurements.uvCoverage === 1);
}

// ---------------------------------------------------------------------------
// 6. mesh.post.gate — fail cases
// ---------------------------------------------------------------------------
{
  // Unparseable bytes.
  const bad = runMeshPostGate(Buffer.from("this is not a glb at all"), GOOD_PROP);
  expectCodes("gate/invalid", hardFailCodes(bad), ["GLTF_INVALID"]);
  check("gate/invalid: not a remesh candidate", !bad.remeshCandidate);
  check("gate/invalid: records parse error", Boolean(bad.parseError));

  // No primitives.
  expectCodes("gate/empty", hardFailCodes(runMeshPostGate(buildEmptyGlb(), GOOD_PROP)), ["EMPTY_GLB"]);

  // NaN vertex.
  const nanMesh = makeBox({ min: [0, 0, 0], max: [1, 1, 1] });
  nanMesh.positions[0] = Number.NaN;
  expectCodes("gate/nan", hardFailCodes(runMeshPostGate(buildGlb(nanMesh), { ...GOOD_PROP, viewSize: 64 })), ["NAN_BOUNDS"]);

  // Missing normals.
  const noNormals = makeBox({ min: [0, 0, 0], max: [1, 1, 1], withNormals: false });
  expectCodes("gate/normals", hardFailCodes(runMeshPostGate(buildGlb(noNormals), { ...GOOD_PROP, viewSize: 64 })), ["NO_NORMALS"]);

  // Flat plane: zero volume and edge-on collapse.
  const planeCodes = hardFailCodes(runMeshPostGate(buildGlb(makePlane(1)), { ...GOOD_PROP, viewSize: 96 }));
  expectCodes("gate/plane", planeCodes, ["THIN_SHELL", "ORBIT_COLLAPSE"]);

  // Hovering.
  const hovering = translate(makeBox({ min: [0, 0, 0], max: [1, 1, 1] }), 0, 0.4, 0);
  expectCodes("gate/hover", hardFailCodes(runMeshPostGate(buildGlb(hovering), { ...GOOD_PROP, viewSize: 64 })), ["NOT_GROUNDED"]);

  // Scale envelope: 20 m is outside the prop range but inside nothing sensible.
  const huge = makeBox({ min: [0, 0, 0], max: [20, 20, 20] });
  expectCodes("gate/scale-prop", hardFailCodes(runMeshPostGate(buildGlb(huge), { ...GOOD_PROP, viewSize: 64 })), ["SCALE"]);

  // A 6 m box is legal for a vehicle (envelope 0.5–12 m) and illegal for a prop
  // (0.05–5 m). Class comes from the compile contract, never from the geometry.
  const car = makeBox({ min: [0, 0, 0], max: [6, 1.4, 1.8] });
  const asVehicle = hardFailCodes(runMeshPostGate(buildGlb(car), { engine: "cloud", profile: "balanced", assetClass: "vehicle", viewSize: 64 }));
  const asProp = hardFailCodes(runMeshPostGate(buildGlb(car), { ...GOOD_PROP, viewSize: 64 }));
  check("gate/class: 6m box is legal as a vehicle", !asVehicle.includes("SCALE"), `got [${asVehicle.join(", ")}]`);
  check("gate/class: 6m box is illegal as a prop", asProp.includes("SCALE"), `got [${asProp.join(", ")}]`);

  // Non-manifold.
  const fin: MeshData = {
    positions: [0, 0, 0, 1, 0, 0, 0.5, 0.5, -1],
    indices: [0, 1, 2],
    normals: [0, 0, -1, 0, 0, -1, 0, 0, -1],
    uvs: [0, 0, 1, 0, 0.5, 1],
  };
  const nonManifold = runMeshPostGate(
    buildGlb(mergeMeshes(makeBox({ min: [0, 0, 0], max: [1, 1, 1] }), fin)),
    { ...GOOD_PROP, viewSize: 64 }
  );
  expectCodes("gate/non-manifold", hardFailCodes(nonManifold), ["NON_MANIFOLD"]);

  // Self-intersection.
  const overlap = runMeshPostGate(
    buildGlb(
      mergeMeshes(
        makeBox({ min: [0, 0, 0], max: [1, 1, 1] }),
        translate(makeBox({ min: [0, 0, 0], max: [1, 1, 1] }), 0.37, 0, 0.41)
      )
    ),
    { ...GOOD_PROP, viewSize: 64 }
  );
  expectCodes("gate/self-intersect", hardFailCodes(overlap), ["SELF_INTERSECT"]);
  check(
    "gate/self-intersect: flagged as remeshable",
    overlap.remeshCandidate,
    `hard codes [${hardFailCodes(overlap).join(", ")}]`
  );

  // Triangle budget on the draft path only.
  const dense = makeBox({ min: [0, 0, 0], max: [1, 1, 1], segments: 70 }); // 6 * 2 * 4900 = 58,800 tris
  const draft = runMeshPostGate(buildGlb(dense), { engine: "cloud", profile: "draft", assetClass: "prop", viewSize: 48, maxPairTests: 20_000 });
  const quality = runMeshPostGate(buildGlb(dense), { engine: "cloud", profile: "quality", assetClass: "prop", viewSize: 48, maxPairTests: 20_000 });
  check("gate/tris: draft rejects 58k triangles", hardFailCodes(draft).includes("TRI_BUDGET"), `got [${hardFailCodes(draft).join(", ")}]`);
  check("gate/tris: quality profile has no draft ceiling", !hardFailCodes(quality).includes("TRI_BUDGET"), `got [${hardFailCodes(quality).join(", ")}]`);

  // Floater: a tiny island under 2% of a dense body.
  const body = makeBox({ min: [0, 0, 0], max: [1, 1, 1], segments: 10 }); // 1,200 tris
  const orphan = translate(makeBox({ min: [0, 0, 0], max: [0.05, 0.05, 0.05] }), 0.5, 0.5, 2);
  const floater = runMeshPostGate(buildGlb(mergeMeshes(body, orphan)), { ...GOOD_PROP, viewSize: 64, maxPairTests: 50_000 });
  expectCodes("gate/floater", hardFailCodes(floater), ["FLOATER"]);

  // Inconclusive self-intersection scans must fail closed, never pass by default.
  const truncated = runMeshPostGate(buildGlb(makeBox({ min: [0, 0, 0], max: [1, 1, 1], segments: 30 })), {
    engine: "cloud",
    profile: "quality",
    assetClass: "prop",
    viewSize: 48,
    maxPairTests: 1,
  });
  check(
    "gate: truncated intersection scan fails closed",
    !truncated.passed && hardFailCodes(truncated).includes("SELF_INTERSECT"),
    `passed=${truncated.passed} codes=[${hardFailCodes(truncated).join(", ")}]`
  );
}

// ---------------------------------------------------------------------------
// 7. Warnings are not HARD fails
// ---------------------------------------------------------------------------
{
  const noUv = makeBox({ min: [0, 0, 0], max: [0.5, 0.5, 0.5], withUvs: false });
  const report = runMeshPostGate(buildGlb(noUv), { ...GOOD_PROP, viewSize: 64 });
  check("gate: missing UV is a warning", report.findings.some((f) => f.code === "NO_UV" && f.severity === "warn"));
  check("gate: missing UV does not block", report.passed, `findings: ${JSON.stringify(report.findings)}`);
}

// Every HARD fail code the gate can emit must be in the HARD set — otherwise a score
// could rescue it downstream.
{
  const { HARD_GEO_FAIL_CODES } = await import("../src/lib/create/contracts.js");
  const geoCodes: FailCode[] = [
    "EMPTY_GLB", "NO_NORMALS", "NON_MANIFOLD", "SELF_INTERSECT",
    "NAN_BOUNDS", "NOT_GROUNDED", "TRI_BUDGET", "FLOATER", "THIN_SHELL", "ORBIT_COLLAPSE",
  ];
  for (const code of geoCodes) {
    check(`contract: ${code} is classified HARD`, HARD_GEO_FAIL_CODES.has(code));
  }
}

// ---------------------------------------------------------------------------
// Water factory execution + interior / part coverage
// ---------------------------------------------------------------------------
{
  const { executeFactoryToGlb } = await import("../src/lib/water/harness/factoryExecute.js");
  const { buildMinimalFactory } = await import("../src/lib/water/harness/fallbackFactory.js");
  const { inspectStructure } = await import("../src/lib/water/harness/structure.js");
  const { interiorDifference } = await import("../src/lib/water/harness/interior.js");
  const { parseGlb } = await import("../src/lib/create/mesh/glb.js");

  const factory = buildMinimalFactory({ prompt: "stylized adventurer", skillId: "character" });
  const executed = executeFactoryToGlb(factory);
  check("factory: createModel executes", executed.ok, executed.ok ? undefined : executed.error);
  if (executed.ok) {
    const parsed = parseGlb(executed.glb);
    check("factory: exported some triangles", parsed.triangleCount > 0, `tris=${parsed.triangleCount}`);
    check("factory: named the head", executed.meshNames.some((n) => /head/i.test(n)), executed.meshNames.join(","));
    const structure = inspectStructure({
      glb: executed.glb,
      specComponents: [
        { name: "head", parent: "body" },
        { name: "body", parent: null },
      ],
      executedNames: executed.meshNames,
    });
    check("factory: part coverage finds head+body", structure.missing.length === 0, structure.missing.join(","));
  }

  const mask = new Uint8Array(32 * 32).fill(1);
  const outline = new Uint8Array(32 * 32);
  for (let x = 0; x < 32; x++) {
    outline[x] = 1;
    outline[31 * 32 + x] = 1;
    outline[x * 32] = 1;
    outline[x * 32 + 31] = 1;
  }
  const filled = interiorDifference({ mask, width: 32, height: 32 }, null);
  check("interior: solid mask passes fill", filled.passed && (filled.score ?? 0) > 0.5, JSON.stringify(filled));
  const hollow = interiorDifference({ mask: outline, width: 32, height: 32 }, null);
  check("interior: outline-only fails fill", !hollow.passed, JSON.stringify(hollow));
}

// ---------------------------------------------------------------------------
if (failures.length) {
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log("all mesh gate assertions passed\n");
