import { logger } from "../../logger.js";
import { MAX_IMAGE_PROMPT_LENGTH, type ImageProvider } from "./config.js";
import { resolveImageApiKey } from "./keys.js";
import { geminiUsageMetadata, openAIChatUsage, recordUsage } from "./usage.js";

const REWRITE_TIMEOUT_MS = 7000;
const OPENAI_REWRITE_MODEL = "gpt-4o-mini";
const GEMINI_REWRITE_MODEL = "gemini-2.5-flash";

/**
 * Hydrilla's global image-generation instruction.
 * Works across characters, vehicles, furniture, animals, weapons, products, buildings, creatures, etc.
 * Formats every prompt for downstream image-to-3D reconstruction (BlueFox3D / Trellis).
 */
export const HYDRILLA_3D_ENGINE_INSTRUCTION = `You are Hydrilla's image-generation engine.

The user's prompt describes the visual asset they want to reconstruct as a
3D model. Generate the closest possible visual interpretation of the user's
request while preserving the original subject, object identity, appearance,
shape, proportions, materials, colors, clothing, surface details, and other
important visual characteristics.

The generated image will be used as input for an image-to-3D reconstruction
pipeline. Therefore, optimize the image for accurate geometry and texture
reconstruction.

3D ASSET REQUIREMENTS:
- Make the requested subject(s) clearly visible and fully within the frame.
- Prioritize the actual subject over the environment or storytelling.
- Keep the subject large in the image with sufficient padding around it.
- Use a clean, simple, uncluttered background: solid neutral light-gray background,
  no scenery, no floor clutter, subtle natural contact shadow only.
- Avoid unnecessary scenery, crowds, background objects, particles, smoke,
  fog, explosions, heavy effects, or visual clutter.
- Avoid motion blur and excessive depth-of-field blur.
- Use clear, even, diffuse lighting that reveals the object's form.
- Preserve fine surface details, edges, materials, textures, and silhouette.
- Avoid objects intersecting or permanently occluding important parts of
  the requested subject.
- Keep important geometry visible from the chosen camera angle.
- Do not crop limbs, wheels, extremities, handles, accessories, or other
  important geometry.
- Prefer a stable three-quarter view when it helps reveal the object's form.
- Keep the camera at a natural distance and avoid extreme perspective
  distortion.
- Do not add text, captions, watermarks, UI elements, borders, or labels
  unless they are an essential physical part of the requested object.
- Do not add decorative elements that are not useful for reconstructing
  the requested asset.

MULTIPLE SUBJECTS / ACTION SCENES:
If the user's request contains multiple subjects or an action scene, prioritize clear
visibility of each subject. Keep subjects spatially separated where possible and avoid
poses where bodies, limbs, weapons, or major geometry overlap. Preserve the
requested interaction and dynamics without sacrificing reconstructable silhouettes.

PRESERVING USER INTENT:
Do not unnecessarily simplify, replace, genericize, or reinterpret the
user's request. Preserve the requested visual concept as closely as possible.

If some part of the request contains protected trademark names, famous superhero/franchise
identities, real persons, or policy restrictions that cannot be directly generated:
- Adapt ONLY the protected names and iconic trade-dress into original, distinctive physical
  descriptions (e.g. for "Hulk", describe "an original towering brawny emerald-skinned warrior
  in earthen leather and stone armor"; for "Thor", describe "an original noble winged knight in
  ornate silver plate with a glowing rune-carved warhammer").
- Do NOT use trademark names, parentheticals (e.g. do not write "(representing Hulk)" or
  "Hulk-like"), or trademarked costume details (e.g. purple torn pants, iconic insignia).
- Maintain all 3D reconstruction qualities (visible geometry, materials, neutral studio background).
- Do not replace the concept with an unrelated generic scene.

IMPORTANT:
The result must be a usable source image for image-to-3D reconstruction,
not a poster, movie frame, illustration layout, action thumbnail, or
marketing image.

Return only the final image-generation prompt.`;

/**
 * Hydrilla 3D Asset Mode suffix appended to every image request.
 */
export const HYDRILLA_3D_ASSET_MODE_SUFFIX = `[HYDRILLA 3D ASSET MODE]
Generate this as a high-quality source image for image-to-3D reconstruction.
Prioritize:
1. Accurate subject identity and shape
2. Complete visible silhouette
3. Clear geometry
4. Surface/material detail
5. Clean separation from background (solid neutral light-gray background, no scenery, no floor clutter, subtle natural contact shadow only)
6. Even diffuse lighting
7. Minimal occlusion
8. Minimal visual clutter
Do not optimize for cinematic storytelling at the expense of reconstructable geometry.`;

/**
 * Restricted-element adaptation instruction used when generation is blocked by moderation.
 * Adapts ONLY the restricted element causing the block while preserving the rest of the asset.
 */
export const RESTRICTED_ELEMENT_ADAPTATION_INSTRUCTION = `You are Hydrilla's restricted-element adaptation engine for 3D asset generation.

An image generation request for a 3D asset was blocked by an upstream safety, copyright, or content policy filter.
Your task is to modify ONLY the specific restricted element that caused the block, rather than rewriting, genericizing, or replacing the user's idea.

FOLLOW THIS STRICT INSTRUCTION HIERARCHY:
1. USER INTENT: Retain the user's exact subject, count, object type, and core concept.
2. PRESERVE APPEARANCE: Keep all allowed visual details, materials, colors, textures, and proportions.
3. PRESERVE CORE ACTION / CONCEPT: Keep the requested posture, dynamic interaction, and spatial arrangement, ensuring subjects remain spatially separated with clear reconstructable silhouettes.
4. MAKE 3D-RECONSTRUCTION FRIENDLY: Solid neutral light-gray studio background, natural contact shadow only, clear diffuse lighting, no visual clutter, no cropped extremities.
5. ADAPT ONLY THE RESTRICTED ELEMENT:
   - If blocked for copyright/trademark/likeness: replace the trademarked design elements (e.g. signature franchise costumes, specific trade-dress garments like purple torn trousers, or exact celebrity faces) with original, distinctive fantasy/sci-fi styling (e.g. an original brawny emerald-skinned warrior clad in earthen leather and stone armor, and an original noble warrior in silver plate with a glowing rune-carved warhammer) without any trademark names, parentheticals, or iconic trade-dress.
   - If blocked for violence/aggression: eliminate direct physical combat strikes or violent weapon clashes; frame subjects in a high-tension, powerful standoff with complete individual silhouettes.
6. The result must be a usable source image for image-to-3D reconstruction, not a movie frame or poster.

Return ONLY the final adapted image-generation prompt.`;

async function callOpenAIChat(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal
): Promise<string | null> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_REWRITE_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `USER REQUEST:\n${userPrompt}` },
      ],
      max_tokens: 350,
      temperature: 0.5,
    }),
    signal,
  });

  if (!res.ok) {
    return null;
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: unknown };
  recordUsage("prompt_rewrite", "openai", OPENAI_REWRITE_MODEL, openAIChatUsage(data?.usage));
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) {
    return null;
  }
  return text.replace(/^["']|["']$/g, "").trim();
}

async function callGeminiChat(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal
): Promise<string | null> {
  const url = `https://aiplatform.googleapis.com/v1/publishers/google/models/${GEMINI_REWRITE_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [{ role: "user", parts: [{ text: `USER REQUEST:\n${userPrompt}` }] }],
      generationConfig: {
        maxOutputTokens: 350,
        temperature: 0.5,
      },
    }),
    signal,
  });

  if (!res.ok) {
    return null;
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: unknown;
  };
  recordUsage("prompt_rewrite", "gemini", GEMINI_REWRITE_MODEL, geminiUsageMetadata(data?.usageMetadata, false));
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) {
    return null;
  }
  return text.replace(/^["']|["']$/g, "").trim();
}

async function executeRewrite(
  systemPrompt: string,
  userPrompt: string,
  preferredProvider: ImageProvider
): Promise<string | null> {
  const signal = AbortSignal.timeout(REWRITE_TIMEOUT_MS);

  const tryOpenAI = async (): Promise<string | null> => {
    const key = await resolveImageApiKey("openai");
    if (!key) {
      return null;
    }
    try {
      return await callOpenAIChat(key, systemPrompt, userPrompt, signal);
    } catch {
      return null;
    }
  };

  const tryGemini = async (): Promise<string | null> => {
    const key = await resolveImageApiKey("gemini");
    if (!key) {
      return null;
    }
    try {
      return await callGeminiChat(key, systemPrompt, userPrompt, signal);
    } catch {
      return null;
    }
  };

  if (preferredProvider === "openai") {
    const primary = await tryOpenAI();
    if (primary) {
      return primary;
    }
    return await tryGemini();
  }

  const primary = await tryGemini();
  if (primary) {
    return primary;
  }
  return await tryOpenAI();
}

export function combineWithSuffix(basePrompt: string): string {
  const candidate = `${basePrompt}\n\n${HYDRILLA_3D_ASSET_MODE_SUFFIX}`;
  if (candidate.length <= MAX_IMAGE_PROMPT_LENGTH) {
    return candidate;
  }
  if (basePrompt.length >= MAX_IMAGE_PROMPT_LENGTH) {
    return basePrompt.slice(0, MAX_IMAGE_PROMPT_LENGTH);
  }
  const remaining = MAX_IMAGE_PROMPT_LENGTH - basePrompt.length - 2;
  return `${basePrompt}\n\n${HYDRILLA_3D_ASSET_MODE_SUFFIX.slice(0, remaining)}`;
}

/**
 * Step 1: Pre-generation Intent Preserver + 3D Optimizer.
 * Preserves the user's subject, shape, materials, and colors while optimizing
 * for image-to-3D geometry (neutral background, even lighting, spatial separation).
 */
export async function optimizePromptFor3D(prompt: string, provider: ImageProvider): Promise<string> {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return prompt;
  }

  try {
    const rewritten = await executeRewrite(HYDRILLA_3D_ENGINE_INSTRUCTION, trimmed, provider);
    if (rewritten && rewritten.length > 5) {
      logger.info(
        { original: trimmed.slice(0, 100), optimized: rewritten.slice(0, 100), provider },
        "Prompt optimized for 3D reconstruction"
      );
      return combineWithSuffix(rewritten);
    }
  } catch (err: unknown) {
    logger.warn({ err, prompt: trimmed.slice(0, 100) }, "3D prompt optimizer encountered an error; using original with suffix");
  }

  return combineWithSuffix(trimmed);
}

/**
 * Step 2 (remediation): Restricted-Element Adaptation.
 * Triggered ONLY after an upstream moderation/safety block.
 * Adapts strictly the restricted element (trademark, likeness, violent clash)
 * while preserving the entire user subject, appearance, and 3D requirements.
 */
export async function adaptRestrictedElement(
  originalPrompt: string,
  errorDetail: string | undefined,
  provider: ImageProvider
): Promise<string> {
  const trimmed = originalPrompt.trim();
  const context = errorDetail
    ? `Original user prompt:\n${trimmed}\n\nUpstream block detail:\n${errorDetail}`
    : trimmed;

  try {
    const adapted = await executeRewrite(RESTRICTED_ELEMENT_ADAPTATION_INSTRUCTION, context, provider);
    if (adapted && adapted.length > 5) {
      logger.info(
        { original: trimmed.slice(0, 100), adapted: adapted.slice(0, 100), provider },
        "Restricted element adapted for 3D generation"
      );
      return combineWithSuffix(adapted);
    }
  } catch (err: unknown) {
    logger.warn({ err, prompt: trimmed.slice(0, 100) }, "Restricted element adaptation encountered an error");
  }

  return combineWithSuffix(trimmed);
}
