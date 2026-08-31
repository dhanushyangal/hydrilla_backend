import type { LanguageModel } from "ai";

export type ApiKeyProvider = "anthropic" | "openai" | "google" | "openrouter" | "cursor";
export type ApiKeyStatus = "unchecked" | "valid" | "invalid";

export const API_KEY_PROVIDERS: ApiKeyProvider[] = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "cursor",
];

export type ListedModel = {
  id: string;
  name: string;
  free?: boolean;
};

export type ConnectorPublic = {
  id: ApiKeyProvider;
  name: string;
  product: string;
  docsUrl: string;
  keyPlaceholder: string;
};

export type Connector = ConnectorPublic & {
  lookLikeKey: (value: string) => boolean;
  keyFormatError: string;
  createModel: (apiKey: string, nativeModelId: string) => LanguageModel;
  listModels: (apiKey: string) => Promise<ListedModel[]>;
  /** Cursor Cloud Agents are not chat-completions. */
  generateTextDirect?: (params: {
    apiKey: string;
    nativeModelId: string;
    system: string;
    userText: string;
    imageUrl?: string | null;
    timeoutMs?: number;
    signal?: AbortSignal;
  }) => Promise<{ text: string; usage: LlmTokenUsage | null }>;
};

export type LlmTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type LlmCallResult = {
  text: string;
  usage: LlmTokenUsage | null;
};
