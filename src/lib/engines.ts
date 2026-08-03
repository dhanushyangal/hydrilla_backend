/**
 * Hydrilla engines:
 * - Hydrilla cloud (trilles / hunyuan) — our GPU, platform credits → GLB
 * - Water — BYOK LLM → procedural Three.js (legacy wire: code_sculpt)
 */

export const ENGINE = {
  hydrilla: {
    id: "hydrilla" as const,
    label: "Hydrilla cloud",
    defaultModelId: "trilles",
    writeEngine: "trilles" as const,
    resultKind: "glb" as const,
  },
  water: {
    id: "water" as const,
    label: "Water",
    generateType: "Water",
    writeEngine: "water" as const,
    writeGenerateType: "Water" as const,
    resultKind: "three_factory" as const,
    legacyEngineIds: ["code_sculpt"] as const,
    legacyGenerateTypes: ["CodeSculpt"] as const,
    errorCode: "water_failed" as const,
    errorCodeLegacy: "code_sculpt_failed" as const,
  },
} as const;

export type JobEngine = "trilles" | "hunyuan" | "water" | "code_sculpt";

export function isWaterEngine(value?: string | null): boolean {
  if (!value) return false;
  const v = value.toLowerCase().replace(/[\s_-]+/g, "");
  return v === "water" || v === "codesculpt" || v.includes("codesculpt");
}

export function isHydrillaCloudEngine(value?: string | null): boolean {
  if (!value) return false;
  const v = value.toLowerCase().replace(/[\s_-]+/g, "");
  return v === "trilles" || v === "trellis" || v === "hunyuan" || v.includes("hunyuan");
}

/** True when GPU status polling should be skipped. */
export function isWaterJobRow(row: {
  engine?: string | null;
  generate_type?: string | null;
  generateType?: string | null;
}): boolean {
  return (
    isWaterEngine(row.engine) ||
    isWaterEngine(row.generate_type) ||
    isWaterEngine(row.generateType)
  );
}
