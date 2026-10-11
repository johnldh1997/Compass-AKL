// --- Nearby Search Query Parsing & Explanation ---
// Two things this service does, both via Claude, both text-only:
//  - POST /parse-nearby: free text -> structured search intent (category, time budget, a named
//    reference location, a target day/time). Never picks a place, route, or time itself — that's
//    real Places/Routes data, computed client-side (see src/services/nearbySearch.ts).
//  - POST /explain-results: the client's own already-computed real results -> a short written
//    reply. Explains results it's given, never invents ones that aren't there.
// This is also the only place the Anthropic API key ever lives — a React Native bundle can't
// hold a secret safely, since there's no equivalent of Google's package-name+SHA1 key
// restriction for it.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { parseNearbyIntent, PreviousIntentSchema } from './parse';

export interface Env {
  ANTHROPIC_API_KEY: string;
}

const ExplainRequestSchema = z.object({
  query: z.string(),
  // False when the user's text gave no day/time at all — the results then weren't filtered by
  // opening hours (see nearbySearch.ts), so some may be closed right now. True means they did
  // give a time, and the results are already confirmed open then.
  hadExplicitTime: z.boolean(),
  results: z.array(
    z.object({
      name: z.string(),
      durationMinutes: z.number(),
      mode: z.enum(['WALK', 'TRANSIT']),
      routeShortName: z.string().optional(),
      rating: z.number().optional(),
      editorialSummary: z.string().optional(),
      isOpenNow: z.boolean().optional(),
      todayHoursText: z.string().optional(),
    })
  ),
});

const EXPLAIN_SYSTEM_PROMPT = `You write short, natural replies for a transit app's nearby-places chat feature.

The user asked a question in free text. You're given the ACTUAL results a real search already found —
real places with real travel times, already ranked. Write a warm, concise reply (2-4 sentences) that
directly answers their question using ONLY the results you're given, in plain prose (not a bulleted list
— the results are already shown to the user as a list below your reply, so don't repeat them as one).
Never invent a place, distance, time, or detail that isn't in the provided list. If the list is empty,
say so plainly and suggest trying a different time, place, or category — don't apologize at length.

When hadExplicitTime is false, the results were NOT filtered by opening hours — some may show
isOpenNow: false. Don't hide this: mention which ones (if any) look closed right now using their
todayHoursText, and end by naturally inviting a specific time if that would help ("Want me to check
what's open at a particular time?") — the user never said when they're going, so ask rather than assume.
When hadExplicitTime is true, the results are already confirmed open at the time asked about, so there's
nothing to caveat or ask about.

You are not picking, ranking, or filtering anything — that's already done. Just explain what was found.`;

// --- Rate Limiting ---
// A per-isolate sliding window, not a distributed one — Workers can spin up multiple isolates
// under load, so this is a soft, best-effort limit, not a hard guarantee. Good enough to stop
// casual abuse of a personal project's API budget; a production version would move this to a
// Durable Object or KV so the count is shared across isolates.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;
const requestLog = new Map<string, number[]>();

function isRateLimited(clientId: string): boolean {
  const now = Date.now();
  const recent = (requestLog.get(clientId) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  requestLog.set(clientId, recent);
  return recent.length > RATE_LIMIT_MAX_REQUESTS;
}

const MAX_TEXT_LENGTH = 300;
const MAX_RESULTS_FOR_EXPLANATION = 10;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function handleAnthropicError(err: unknown, routeLabel: string): Response {
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

async function handleParseNearby(request: Request, client: Anthropic): Promise<Response> {
  let text: unknown;
  let previousIntentRaw: unknown;
  try {
    const body = await request.json();
    text = (body as { text?: unknown })?.text;
    previousIntentRaw = (body as { previousIntent?: unknown })?.previousIntent;
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  if (typeof text !== 'string' || !text.trim()) {
    return jsonResponse({ error: '"text" is required' }, 400);
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return jsonResponse({ error: `"text" must be under ${MAX_TEXT_LENGTH} characters` }, 400);
  }
  // Client-supplied, so validated the same way a fresh request body would be — an invalid or
  // absent previousIntent just means this is treated as a turn with no prior context, not an
  // error, since the field is optional by nature. confident is kept (the model needs it to tell
  // a refinement apart from an answer to its own clarifying question); the question text itself
  // isn't, since the model already knows what it asked without seeing it echoed back.
  const previousIntentResult = PreviousIntentSchema.safeParse(previousIntentRaw);
  const previousIntent = previousIntentResult.success ? previousIntentResult.data : null;

  try {
    const { parsed } = await parseNearbyIntent(client, text, previousIntent);

    if (!parsed) {
      return jsonResponse({ error: 'Could not parse a query from that text' }, 422);
    }
    return jsonResponse(parsed);
  } catch (err) {
    return handleAnthropicError(err, 'Query parsing');
  }
}

async function handleExplainResults(request: Request, client: Anthropic): Promise<Response> {
  let parsed: z.infer<typeof ExplainRequestSchema>;
  try {
    const body = await request.json();
    parsed = ExplainRequestSchema.parse(body);
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }
  if (!parsed.query.trim()) {
    return jsonResponse({ error: '"query" is required' }, 400);
  }
  if (parsed.query.length > MAX_TEXT_LENGTH) {
    return jsonResponse({ error: `"query" must be under ${MAX_TEXT_LENGTH} characters` }, 400);
  }
  // The client already caps how many results it routes, but this guards the prompt itself
  // against an unexpectedly large payload regardless of what the caller sends.
  const results = parsed.results.slice(0, MAX_RESULTS_FOR_EXPLANATION);

  const resultsText =
    results.length === 0
      ? '(no results found)'
      : results
          .map((r) => {
            const travel = r.mode === 'WALK' ? `${r.durationMinutes} min walk` : `${r.durationMinutes} min via ${r.routeShortName ?? 'transit'}`;
            const rating = r.rating != null ? `, rated ${r.rating}★` : '';
            const summary = r.editorialSummary ? ` — ${r.editorialSummary}` : '';
            const hours = r.isOpenNow != null ? `, ${r.isOpenNow ? 'open now' : 'closed now'}${r.todayHoursText ? ` (${r.todayHoursText})` : ''}` : '';
            return `- ${r.name}: ${travel}${rating}${hours}${summary}`;
          })
          .join('\n');

  try {
    const response = await client.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 300,
      system: EXPLAIN_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `User's question: "${parsed.query}"\nhadExplicitTime: ${parsed.hadExplicitTime}\n\nActual results found:\n${resultsText}`,
        },
      ],
    });
    const reply = response.content.find((block) => block.type === 'text')?.text ?? '';
    return jsonResponse({ reply });
  } catch (err) {
    return handleAnthropicError(err, 'Result explanation');
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Only POST is supported' }, 405);
    }
    const url = new URL(request.url);
    if (url.pathname !== '/parse-nearby' && url.pathname !== '/explain-results') {
      return jsonResponse({ error: 'Not found' }, 404);
    }

    const clientId = request.headers.get('cf-connecting-ip') ?? 'unknown';
    if (isRateLimited(clientId)) {
      return jsonResponse({ error: 'Too many requests, try again shortly' }, 429);
    }

    if (!env.ANTHROPIC_API_KEY) {
      return jsonResponse({ error: 'Server misconfigured: ANTHROPIC_API_KEY is not set' }, 500);
    }
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

    if (url.pathname === '/parse-nearby') {
      return handleParseNearby(request, client);
    }
    return handleExplainResults(request, client);
  },
};
