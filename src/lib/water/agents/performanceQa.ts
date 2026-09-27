export type PerformanceQaReport = {
  triangleCount: number | null;
  drawCalls: number | null;
  meshCount: number;
  suggestions: string[];
};

export function runPerformanceQa(params: {
  triangleCount?: number | null;
  drawCalls?: number | null;
  meshNames?: string[];
}): PerformanceQaReport {
  const meshCount = params.meshNames?.length || 0;
  const triangles = params.triangleCount ?? null;
  const drawCalls = params.drawCalls ?? (meshCount || null);
  const suggestions: string[] = [];
  if (triangles != null && triangles > 80_000) {
    suggestions.push("Triangle count is high for the browser. Simplify secondary parts.");
  }
  if (drawCalls != null && drawCalls > 24) {
    suggestions.push("Too many draw calls — share materials on repeated parts.");
  }
  if (meshCount === 0) {
    suggestions.push("No named meshes yet. Generate so Parts can list them.");
  }
  if (suggestions.length === 0) {
    suggestions.push("Within a typical browser budget.");
  }
  return { triangleCount: triangles, drawCalls, meshCount, suggestions };
}
