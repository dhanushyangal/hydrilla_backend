import { z } from "zod";

export const sculptSpecSchema = z
  .object({
    name: z.string(),
    subjectClass: z.enum(["object", "character", "hybrid", "environment"]).optional(),
    complexity: z.enum(["simple", "moderate", "complex"]).optional(),
    summary: z.string().optional(),
    scale: z
      .object({
        unit: z.string().optional(),
        approxHeight: z.number().optional(),
      })
      .optional(),
    materials: z
      .array(
        z.object({
          name: z.string(),
          color: z.string().optional(),
          finish: z.string().optional(),
          roughness: z.number().optional(),
          metalness: z.number().optional(),
        })
      )
      .optional(),
    components: z.array(
      z.object({
        name: z.string(),
        primitive: z.string().optional(),
        parent: z.string().nullable().optional(),
        size: z.array(z.number()).optional(),
        position: z.array(z.number()).optional(),
        rotation: z.array(z.number()).optional(),
        material: z.string().optional(),
        notes: z.string().optional(),
        topologyClass: z.string().optional(),
      })
    ),
    animation: z
      .object({
        idle: z.string().optional(),
        sockets: z.array(z.string()).optional(),
      })
      .optional(),
    qualityContract: z
      .object({
        fidelityBar: z.enum(["blockout", "production", "hero"]).optional(),
        mustHaveDetails: z.array(z.string()).optional(),
        forbiddenShortcuts: z.array(z.string()).optional(),
        notes: z.string().optional(),
      })
      .optional(),
    detailInventory: z
      .array(
        z.object({
          id: z.string().optional(),
          zone: z.string().optional(),
          detail: z.string().optional(),
          mapsTo: z.string().optional(),
        })
      )
      .optional(),
    featureReviewTargets: z
      .array(
        z.object({
          id: z.string().optional(),
          importance: z.enum(["critical", "important"]).optional(),
          pass: z.string().optional(),
        })
      )
      .optional(),
  })
  .passthrough();

export const evaluatorSchema = z.object({
  fidelity: z.number(),
  action: z.string(),
  summary: z.string(),
  criteriaScores: z.record(z.string(), z.number()).optional(),
});
