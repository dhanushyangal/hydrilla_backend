/**
 * Verify OpenAI / Gemini image request payloads against the provider docs.
 *
 * Pure in-memory checks — no network, no API keys. Run with:
 *   npm run verify:images
 *
 * Docs:
 *   https://developers.openai.com/api/docs/guides/image-generation
 *   https://ai.google.dev/gemini-api/docs/image-generation
 *   https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/image-generation
 */

import {
  GEMINI_IMAGE_SIZE,
  IMAGE_ASPECTS,
  IMAGE_CREDITS,
  IMAGE_QUALITIES,
  OPENAI_QUALITY,
  OPENAI_SIZES,
  parseImageAspect,
  parseImageProvider,
  parseImageQuality,
} from "../src/services/imageProviders/config.js";
import { buildOpenAIEditFields, buildOpenAIGenerateBody } from "../src/services/imageProviders/openai.js";
import {
  buildGeminiBody,
  buildVertexGeminiBody,
  extractGeminiImage,
  extractVertexGeminiImage,
} from "../src/services/imageProviders/gemini.js";

let failures = 0;

function check(name: string, condition: boolean) {
  if (!condition) failures++;
  console.log(`${condition ? "  ok  " : " FAIL "} ${name}`);
}

const OPENAI_QUALITY_VALUES = new Set(["low", "medium", "high", "xhigh", "max", "auto"]);
const GEMINI_SIZES = new Set(["512px", "1K", "2K", "4K"]);
const GEMINI_ASPECTS = new Set(["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"]);

function validOpenAISize(size: string): boolean {
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (!m) return false;
  const w = Number(m[1]);
  const h = Number(m[2]);
  const px = w * h;
  const ratio = Math.max(w, h) / Math.min(w, h);
  return w % 16 === 0 && h % 16 === 0 && ratio <= 3 && px >= 655_360 && px <= 8_294_400 && Math.max(w, h) <= 3840;
}

function aspectOf(size: string): string {
  const [w, h] = size.split("x").map(Number);
  const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
  const d = g(w, h);
  return `${w / d}:${h / d}`;
}

console.log("OpenAI");
for (const quality of IMAGE_QUALITIES) {
  check(`quality "${OPENAI_QUALITY[quality]}" (${quality}) is a documented value`, OPENAI_QUALITY_VALUES.has(OPENAI_QUALITY[quality]));
  for (const aspect of IMAGE_ASPECTS) {
    const size = OPENAI_SIZES[quality][aspect];
    check(`${quality} ${aspect} size ${size} meets size rules`, validOpenAISize(size));
    check(`${quality} ${aspect} size ${size} matches aspect`, aspectOf(size) === aspect);
    const body = buildOpenAIGenerateBody("a red car", quality, aspect);
    check(
      `${quality} ${aspect} generate body has model/prompt/quality/size/output_format/n`,
      !!body.model && body.prompt === "a red car" && body.size === size && body.output_format === "png" && body.n === 1
    );
    check(`${quality} ${aspect} generate body omits response_format (gpt-image returns b64)`, !("response_format" in body));
  }
  const edit = buildOpenAIEditFields("make it blue", quality);
  check(`${quality} edit uses size "auto"`, edit.size === "auto");
  check(
    `${quality} generate + edit send moderation "low" by default`,
    buildOpenAIGenerateBody("x", quality, "1:1").moderation === "low" && edit.moderation === "low"
  );
  check(`${quality} edit fields are strings (multipart)`, Object.values(edit).every((v) => typeof v === "string"));
}
check("low and high use different models", buildOpenAIGenerateBody("x", "low", "1:1").model !== buildOpenAIGenerateBody("x", "high", "1:1").model);

console.log("Gemini");
for (const quality of IMAGE_QUALITIES) {
  check(`image_size "${GEMINI_IMAGE_SIZE[quality]}" (${quality}) is a documented value`, GEMINI_SIZES.has(GEMINI_IMAGE_SIZE[quality]));
  for (const aspect of IMAGE_ASPECTS) {
    const body = buildGeminiBody("a red car", quality, aspect);
    check(`${quality} ${aspect} aspect_ratio is documented`, GEMINI_ASPECTS.has(String(body.response_format.aspect_ratio)));
    check(`${quality} ${aspect} response_format.type is image`, body.response_format.type === "image");
    check(`${quality} ${aspect} input is a text block`, body.input.length === 1 && body.input[0].type === "text");
  }
  const edit = buildGeminiBody("make it blue", quality, null, { mime_type: "image/png", data: "AAAA" });
  check(`${quality} edit omits aspect_ratio`, !("aspect_ratio" in edit.response_format));
  check(`${quality} edit sends text + image blocks`, edit.input.length === 2 && edit.input[1].type === "image");
}
check("low and high use different models", buildGeminiBody("x", "low", "1:1").model !== buildGeminiBody("x", "high", "1:1").model);

const sample = {
  steps: [
    { type: "thought", content: [{ type: "image", data: "draft", mime_type: "image/png" }] },
    { type: "model_output", content: [{ type: "text", text: "Here you go" }, { type: "image", data: "final", mime_type: "image/png" }] },
  ],
};
check("extractGeminiImage takes the model_output image, not the thought draft", extractGeminiImage(sample)?.data === "final");
check("extractGeminiImage returns null with no image", extractGeminiImage({ steps: [] }) === null);

console.log("Gemini (Vertex AI)");
for (const quality of IMAGE_QUALITIES) {
  for (const aspect of IMAGE_ASPECTS) {
    const body = buildVertexGeminiBody("a red car", quality, aspect);
    const cfg = body.generationConfig.imageConfig;
    check(`${quality} ${aspect} imageConfig aspect/size/png`, cfg.aspectRatio === aspect && cfg.imageSize === GEMINI_IMAGE_SIZE[quality] && cfg.imageOutputOptions.mimeType === "image/png");
    check(`${quality} ${aspect} asks for IMAGE modality`, body.generationConfig.responseModalities.includes("IMAGE"));
  }
  const edit = buildVertexGeminiBody("make it blue", quality, null, { mime_type: "image/png", data: "AAAA" });
  const parts = edit.contents[0].parts;
  check(`${quality} Vertex edit omits aspectRatio`, !("aspectRatio" in edit.generationConfig.imageConfig));
  check(`${quality} Vertex edit sends image then text`, parts.length === 2 && "inlineData" in parts[0] && "text" in parts[1]);
}
const vertexSample = {
  candidates: [
    {
      content: {
        parts: [
          { thought: true, inlineData: { mimeType: "image/png", data: "draft" } },
          { text: "Here you go" },
          { inlineData: { mimeType: "image/png", data: "final" } },
        ],
      },
    },
  ],
};
check("extractVertexGeminiImage skips thought parts", extractVertexGeminiImage(vertexSample)?.data === "final");
check("extractVertexGeminiImage returns null with no image", extractVertexGeminiImage({ candidates: [] }) === null);

console.log("Options + credits");
check("provider defaults to openai", parseImageProvider(undefined) === "openai");
check("provider accepts google alias", parseImageProvider("google") === "gemini");
check("provider rejects unknown", parseImageProvider("flux") === null);
check("quality defaults to low", parseImageQuality("") === "low");
check("quality rejects unknown", parseImageQuality("ultra") === null);
check("aspect defaults to 1:1", parseImageAspect(undefined) === "1:1");
check("aspect rejects unknown", parseImageAspect("16:9") === null);
check("text-to-image credits 2 / 5", IMAGE_CREDITS["text-to-image"].low === 2 && IMAGE_CREDITS["text-to-image"].high === 5);
check("edit credits 3 / 6", IMAGE_CREDITS.edit.low === 3 && IMAGE_CREDITS.edit.high === 6);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll image provider checks passed");
