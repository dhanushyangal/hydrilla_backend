import { logger } from "../../logger.js";

/** USD per 1M tokens, split by modality because image tokens are billed far higher than text. */
export type ModelPrice = {
  textInput: number;
  imageInput: number;
  textOutput: number;
  imageOutput: number;
};

/**
 * Provider list prices. Keys match a model exactly or as a prefix (longest wins).
 * Override or add models with IMAGE_PRICING_JSON, e.g.
 * {"gpt-image-2.5-sunburst":{"textInput":5,"imageInput":8,"textOutput":10,"imageOutput":32}}
 */
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "gpt-4o-mini": { textInput: 0.15, imageInput: 0.15, textOutput: 0.6, imageOutput: 0 },
  "gpt-image-1-mini": { textInput: 2, imageInput: 2.5, textOutput: 0, imageOutput: 8 },
  "gpt-image-1": { textInput: 5, imageInput: 10, textOutput: 0, imageOutput: 40 },
  "gpt-image": { textInput: 5, imageInput: 8, textOutput: 10, imageOutput: 32 },
  "gemini-2.5-flash": { textInput: 0.3, imageInput: 0.3, textOutput: 2.5, imageOutput: 30 },
  "gemini-3-pro-image": { textInput: 2, imageInput: 2, textOutput: 12, imageOutput: 120 },
  "gemini-3.1-flash-image": { textInput: 0.3, imageInput: 0.3, textOutput: 2.5, imageOutput: 30 },
  gemini: { textInput: 0.3, imageInput: 0.3, textOutput: 2.5, imageOutput: 30 },
};

function isModelPrice(v: unknown): v is ModelPrice {
  if (!v || typeof v !== "object") {
    return false;
  }
  const p = v as Record<string, unknown>;
  return ["textInput", "imageInput", "textOutput", "imageOutput"].every(
    (k) => typeof p[k] === "number" && Number.isFinite(p[k] as number) && (p[k] as number) >= 0
  );
}

function loadOverrides(): Record<string, ModelPrice> {
  const raw = process.env.IMAGE_PRICING_JSON?.trim();
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, ModelPrice] => isModelPrice(entry[1]))
    );
  } catch (err) {
    logger.warn({ err }, "IMAGE_PRICING_JSON is not valid JSON; using default prices");
    return {};
  }
}

const PRICES: Record<string, ModelPrice> = { ...DEFAULT_PRICES, ...loadOverrides() };

export function priceForModel(model: string): ModelPrice | null {
  const name = model.trim().toLowerCase();
  if (PRICES[name]) {
    return PRICES[name];
  }
  const prefix = Object.keys(PRICES)
    .filter((key) => name.startsWith(key))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? PRICES[prefix] : null;
}
