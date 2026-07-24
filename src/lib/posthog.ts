import { PostHog } from "posthog-node";

let client: PostHog | null = null;

function getToken(): string | undefined {
  return (
    process.env.POSTHOG_API_KEY ||
    process.env.POSTHOG_PROJECT_TOKEN ||
    process.env.NEXT_PUBLIC_POSTHOG_KEY ||
    process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
  );
}

function getHost(): string {
  return (
    process.env.POSTHOG_HOST ||
    process.env.NEXT_PUBLIC_POSTHOG_HOST ||
    "https://us.i.posthog.com"
  );
}

export function getPostHog(): PostHog | null {
  const token = getToken();
  if (!token) return null;

  if (!client) {
    client = new PostHog(token, {
      host: getHost(),
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return client;
}

/**
 * Capture a server-side product event.
 * Never include prompt text or raw customer PII beyond user id / plan.
 */
export function captureServerEvent(
  distinctId: string | null | undefined,
  event: string,
  properties?: Record<string, string | number | boolean | null | undefined>
): void {
  try {
    const ph = getPostHog();
    if (!ph) return;
    ph.capture({
      distinctId: distinctId || "anonymous",
      event,
      properties: {
        ...properties,
        source: "backend",
      },
    });
  } catch {
    /* analytics must never break billing */
  }
}

export async function flushPostHog(): Promise<void> {
  try {
    await client?.flush();
  } catch {
    /* ignore */
  }
}
