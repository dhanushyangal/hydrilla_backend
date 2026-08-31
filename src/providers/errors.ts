import type { ApiKeyProvider } from "./types.js";

export function friendlyProviderError(provider: ApiKeyProvider, status: number, body: string): string {
  if (status === 429) {
    return provider === "openrouter"
      ? "Free model rate limit reached (~20/min, ~50/day). Wait a minute, or pick Auto Free / another free model."
      : "Provider rate limit reached. Wait a moment and try again.";
  }

  if (provider === "anthropic") {
    const snippet = anthropicErrorSnippet(body);
    const errType = parseAnthropicErrorType(body);
    if (errType === "authentication_error" || status === 401) {
      return `Anthropic API key invalid or expired. Re-create at platform.claude.com/settings/keys and re-verify in Settings.${
        snippet ? ` (${snippet})` : ""
      }`;
    }
    if (errType === "permission_error" || status === 403) {
      return `Anthropic key lacks access to this model or workspace. Check Console permissions/billing.${
        snippet ? ` (${snippet})` : ""
      }`;
    }
    if (errType === "billing_error" || status === 402) {
      return `Anthropic billing/payment issue. Add credits in the Claude Console.${
        snippet ? ` (${snippet})` : ""
      }`;
    }
    if (errType === "not_found_error" || status === 404) {
      return `Anthropic model id not found (not a key rejection).${snippet ? ` (${snippet})` : ""}`;
    }
    return `Anthropic request failed (${status}): ${snippet || body.slice(0, 240)}`;
  }

  if (status === 401 || status === 403) {
    return "Your API key was rejected. Re-check it in Settings.";
  }
  return `${provider} request failed (${status}): ${body.slice(0, 240)}`;
}

function parseAnthropicErrorType(body: string): string | null {
  try {
    const json = JSON.parse(body) as { error?: { type?: string } };
    return json?.error?.type || null;
  } catch {
    return null;
  }
}

function anthropicErrorSnippet(body: string): string {
  try {
    const json = JSON.parse(body) as { error?: { message?: string } };
    const msg = json?.error?.message?.trim();
    if (msg) return msg.slice(0, 160);
  } catch {
    /* fall through */
  }
  return body.replace(/\s+/g, " ").trim().slice(0, 160);
}
