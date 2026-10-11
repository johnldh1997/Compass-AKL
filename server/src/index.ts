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
  // opening hours (see nearbySearch.ts), so some may be closed by the time the user gets there.
  // True means they did give a time, and the results are already confirmed open on arrival.
  hadExplicitTime: z.boolean(),
  // How the (already ordered) results were ranked — closest first, or best rated first.
  rankedBy: z.enum(['nearest', 'best']).default('nearest'),
  results: z.array(
    z.object({
      name: z.string(),
      durationMinutes: z.number(),
      mode: z.enum(['WALK', 'TRANSIT']),
      routeShortName: z.string().optional(),
      rating: z.number().optional(),
      editorialSummary: z.string().optional(),
      // Judged at departure + travel time, not at departure (see withArrivalHours).
      isOpenOnArrival: z.boolean().optional(),
      // Only present when it is open on arrival but closes within the hour after.
      closesInMinutes: z.number().optional(),
      // 0 (free) to 4 (very expensive); each detail is only present when Places actually knows it.
      priceLevel: z.number().optional(),
      servesVegetarianFood: z.boolean().optional(),
      outdoorSeating: z.boolean().optional(),
      todayHoursText: z.string().optional(),
    })
  ),
});

const EXPLAIN_SYSTEM_PROMPT = `You write short, natural replies for a transit app's nearby-places chat feature.

The user asked a question in free text. You're given the ACTUAL results a real search already found —
real places with real travel times, already ranked. Write a warm, concise reply (2-4 sentences) that
directly answers their question using ONLY the results you're given, in plain prose (not a bulleted list
— the results are already shown to the user as a list below your reply, so don't repeat them as one).
Plain text only: no markdown, no bold or asterisks — your reply is shown exactly as written. Reply in the
same language the user's question is written in (Korean question, Korean reply).
Never invent a place, distance, time, or detail that isn't in the provided list. If the list is empty,
say so plainly and suggest trying a different time, place, or category — don't apologize at length.

Opening hours are judged at the moment the user would ARRIVE (when they leave plus the travel time), not
when they leave. When hadExplicitTime is false, the results were NOT filtered by opening hours — some may
be marked "closed by the time you arrive". Don't hide this: mention which ones (if any) would be closed
when the user gets there, using their hours text, and end by naturally inviting a specific time if that
would help ("Want me to check what's open at a particular time?") — the user never said when they're
going, so ask rather than assume. When hadExplicitTime is true, the results are already confirmed open on
arrival, so there's nothing to caveat about being closed or ask about the time. Either way, if a result
is marked as closing a few minutes after the user would arrive, say so — it's worth knowing before they
set off.

The results are ordered already: closest first, or best rated first when rankedBy is "best" — in that
case it's natural to point out the top pick and why (its rating), not just the nearest. Mention a price,
vegetarian or outdoor-seating detail only for a result that actually lists it. If the user asked for one
of those and a result doesn't list it, that just means it wasn't confirmed — never claim it for that place.

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
            const details = [
              r.priceLevel != null && r.priceLevel >= 1 ? `price ${'$'.repeat(r.priceLevel)}` : null,
              r.servesVegetarianFood ? 'has vegetarian options' : null,
              r.outdoorSeating ? 'has outdoor seating' : null,
            ]
              .filter(Boolean)
              .map((d) => `, ${d}`)
              .join('');
            const summary = r.editorialSummary ? ` — ${r.editorialSummary}` : '';
            const status =
              r.isOpenOnArrival == null
                ? null
                : !r.isOpenOnArrival
                  ? 'closed by the time you arrive'
                  : r.closesInMinutes != null
                    ? `open when you arrive but closes ${r.closesInMinutes} min after`
                    : 'open when you arrive';
            const hours = status ? `, ${status}${r.todayHoursText ? ` (${r.todayHoursText})` : ''}` : '';
            return `- ${r.name}: ${travel}${rating}${details}${hours}${summary}`;
          })
          .join('\n');

  try {
    const response = await client.messages.create({
      // Kept on Opus on purpose: Haiku 5.5 and Sonnet 5.5 answered a Korean question in English, even
      // with an explicit reply-in-the-user's-language rule, and the reply is what the user reads.
      model: 'claude-opus-5-5',
      // Opus 5.5 always thinks first, and that hidden reasoning shares this budget — at 300 the
      // reply came back empty or cut off mid-sentence. The visible reply is only a few sentences.
      max_tokens: 2000,
      system: EXPLAIN_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `User's question: "${parsed.query}"\nhadExplicitTime: ${parsed.hadExplicitTime}\nrankedBy: ${parsed.rankedBy}\n\nActual results found:\n${resultsText}`,
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
