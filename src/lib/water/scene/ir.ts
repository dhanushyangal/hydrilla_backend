/** Scene IR v0 — camera, lights, one asset instance. Source of truth for layout. */

export type Vec3 = [number, number, number];

export type SceneMaterialPatch = {
  color?: string;
  roughness?: number;
  metalness?: number;
};

export type SceneInstance = {
  nodeId: string;
  assetId: string;
  name: string;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  material?: SceneMaterialPatch | null;
  /** Per-mesh overrides keyed by the factory mesh name. */
  partMaterials?: Record<string, SceneMaterialPatch>;
};

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function parseMaterialPatch(raw: unknown): SceneMaterialPatch | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const patch: SceneMaterialPatch = {};
  if (typeof o.color === "string" && /^#[0-9a-f]{6}$/i.test(o.color)) patch.color = o.color.toLowerCase();
  if (typeof o.roughness === "number" && Number.isFinite(o.roughness)) patch.roughness = clamp01(o.roughness);
  if (typeof o.metalness === "number" && Number.isFinite(o.metalness)) patch.metalness = clamp01(o.metalness);
  return Object.keys(patch).length ? patch : null;
}

export function parsePartMaterials(raw: unknown): Record<string, SceneMaterialPatch> {
  if (!raw || typeof raw !== "object") return {};
  const parts: Record<string, SceneMaterialPatch> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const patch = parseMaterialPatch(value);
    if (name && patch) parts[name] = patch;
  }
  return parts;
}

export type SceneIR = {
  version: 0;
  camera: {
    position: Vec3;
    target: Vec3;
    fov: number;
  };
  lights: Array<{
    type: "hemisphere" | "directional";
    intensity: number;
    position?: Vec3;
  }>;
  instances: SceneInstance[];
};

export const DEFAULT_SCENE_IR: SceneIR = {
  version: 0,
  camera: {
    position: [2.4, 1.6, 2.8],
    target: [0, 0.4, 0],
    fov: 45,
  },
  lights: [
    { type: "hemisphere", intensity: 0.55 },
    { type: "directional", intensity: 1.35, position: [4, 8, 5] },
  ],
  instances: [],
};

export function vec3(value: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(value) || value.length < 3) return fallback;
  return [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0];
}

export function parseSceneIR(raw: unknown): SceneIR {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SCENE_IR, instances: [] };
  const o = raw as Partial<SceneIR>;
  return {
    version: 0,
    camera: {
      position: vec3(o.camera?.position, DEFAULT_SCENE_IR.camera.position),
      target: vec3(o.camera?.target, DEFAULT_SCENE_IR.camera.target),
      fov: typeof o.camera?.fov === "number" ? o.camera.fov : 45,
    },
    lights: Array.isArray(o.lights) && o.lights.length > 0 ? o.lights : DEFAULT_SCENE_IR.lights,
    instances: Array.isArray(o.instances) ? o.instances : [],
  };
}
