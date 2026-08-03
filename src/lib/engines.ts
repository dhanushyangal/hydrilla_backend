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

/** Water job ids: `wt_` (current) or legacy `cs_`. */
export function isWaterJobId(id?: string | null): boolean {
  if (!id) return false;
  return id.startsWith("wt_") || id.startsWith("cs_");
}

/** True when GPU status polling / GLB proxy should be skipped. */
export function isWaterJobRow(row: {
  id?: string | null;
  engine?: string | null;
  generate_type?: string | null;
  generateType?: string | null;
  result_kind?: string | null;
  resultKind?: string | null;
  factory_code?: string | null;
}): boolean {
  if (isWaterJobId(row.id)) return true;
  if (
    isWaterEngine(row.engine) ||
    isWaterEngine(row.generate_type) ||
    isWaterEngine(row.generateType)
  ) {
    return true;
  }
  const kind = row.result_kind || row.resultKind;
  if (kind === "three_factory") return true;
  if (row.factory_code && String(row.factory_code).length > 0) return true;
  return false;
}
