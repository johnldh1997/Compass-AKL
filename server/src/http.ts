// --- HTTP Helpers ---
// Small things every endpoint needs: a JSON response, a size-capped JSON body reader, and the
// translation of an Anthropic API failure into a response the app can show without leaking details.
import Anthropic from '@anthropic-ai/sdk';

export const MAX_TEXT_LENGTH = 300;

// Every legitimate body is a sentence plus at most a few KB of context (ten results, a few saved place
// names), so anything bigger is not from the app — refuse it before spending CPU parsing it.
const MAX_BODY_CHARS = 32_000;

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

// The parsed JSON body, or the error response to send instead.
export async function readJsonBody(request: Request): Promise<{ body: unknown } | { error: Response }> {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { error: jsonResponse({ error: 'Invalid request body' }, 400) };
  }
  if (raw.length > MAX_BODY_CHARS) return { error: jsonResponse({ error: 'Request body too large' }, 413) };
  try {
    return { body: JSON.parse(raw) };
  } catch {
    return { error: jsonResponse({ error: 'Invalid JSON body' }, 400) };
  }
}

export function handleAnthropicError(err: unknown, routeLabel: string): Response {
  if (err instanceof Anthropic.RateLimitError) {
    return jsonResponse({ error: 'Upstream rate limited, try again shortly' }, 503);
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return jsonResponse({ error: 'Server misconfigured: ANTHROPIC_API_KEY was rejected' }, 500);
  }
  if (err instanceof Anthropic.APIError) {
    return jsonResponse({ error: `${routeLabel} is unavailable right now` }, 502);
  }
  console.error(`Unexpected error in ${routeLabel}:`, err);
  return jsonResponse({ error: 'Something went wrong' }, 500);
}
