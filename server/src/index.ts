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
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

export interface Env {
  ANTHROPIC_API_KEY: string;
}

const TARGET_DAYS = ['today', 'tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

const NearbyQuerySchema = z.object({
  category: z
    .string()
    .describe(
      "A short search phrase for Google Places, e.g. 'Japanese restaurant' or 'coffee shop'. Empty string if no category is identifiable."
    ),
  maxMinutes: z
    .number()
    .int()
    .min(1)
    .max(120)
    .nullable()
    .describe(
      'Maximum acceptable travel time in minutes, only if the user actually stated one (directly or as a distance). Null if they gave no time or distance limit at all — e.g. "closest X" has no limit; do not invent one.'
    ),
  modes: z
    .array(z.enum(['WALK', 'TRANSIT']))
    .describe('Which travel modes are acceptable. Default to both if the user did not specify.'),
  useSavedHome: z
    .boolean()
    .describe(
      "True if the user referred to their own home/house as the starting point (e.g. 'home', '집', 'my place', 'near my house') — this is a personal reference to their saved home address in the app, never a business or place name to search for. False otherwise. When true, referenceLocationText must be null."
    ),
  referenceLocationText: z
    .string()
    .nullable()
    .describe(
      "A specific named place the user gave as their starting point, in a form Google Places can search for (e.g. 'Britomart', 'the airport') — never 'home' or an equivalent (see useSavedHome for that). If they named it in a different script/language and you're confident of its actual English/common name (e.g. '브리토마트' meaning Britomart, a real Auckland train station), use that name instead of transliterating — this is translation of a known place, not inventing one. If unsure, pass through what they said as-is. Null if they named no such place, in which case their current live location is used instead."
    ),
  targetDay: z
    .enum(TARGET_DAYS)
    .nullable()
    .describe(
      "Which day the user means, only if they actually said one: 'today', 'tomorrow', or a weekday name. Null if they mentioned no day at all — assume right now."
    ),
  hour: z
    .number()
    .int()
    .min(0)
    .max(23)
    .nullable()
    .describe(
      "The hour (24-hour clock) the user means — including a representative hour for a vague time-of-day word like 'evening' (~18) or 'lunch' (~12), not just an exact stated time. Null only if the user gave no time reference at all."
    ),
  minute: z
    .number()
    .int()
    .min(0)
    .max(59)
    .nullable()
    .describe('The minute the user means; 0 if they gave an hour but no minute. Null if no specific time was stated at all.'),
  confident: z
    .boolean()
    .describe('False if a search category could not be confidently identified from the text.'),
  clarifyingQuestion: z
    .string()
    .nullable()
    .describe(
      'A short, specific question to ask the user, only when confident is false — asking exactly for whatever is missing or ambiguous (e.g. "What kind of food are you after?"). Null whenever confident is true.'
    ),
});

const PARSE_SYSTEM_PROMPT = `You extract structured search parameters from a transit app user's free-text request for nearby places.

The text is casual, spoken-style input — expect missing punctuation and informal phrasing (e.g. "japanese
food" means Japanese restaurant). An unfamiliar word is not necessarily a typo — it may be the name of a
real shop, brand, or chain you don't recognize (e.g. a specific drink or dessert shop name); when the text
reads as a proper name for a place, pass it through as-is rather than "correcting" it to a generic food
type, since Google Places can look up specific brand names directly. Only fix a word when it's clearly a
garbled version of an ordinary word with no plausible reading as a name. Only set confident to false and
leave category empty when the category is genuinely ambiguous or entirely absent from the text — not
merely because it's informally worded or an unfamiliar name. A bare reference to food or a place to eat
with no further qualifier at all — no cuisine, no dish, no specific business type or name (e.g. "somewhere
to eat", "a place to eat", "food", "restaurant", or the equivalent in any language) — counts as absent, not
identified: set confident to false and ask what kind of food or place they're after, same as any other
missing category. Apply this exact same bar regardless of which language the request is phrased in — the
same degree of vagueness must get the same treatment whether it's asked in English, Korean, or otherwise;
don't let one language's phrasing read as more specific than an equivalent phrasing in another. Never invent a category, time budget, or
travel mode that has no basis in the text at all — a plain "closest X" or "nearest X" has no time budget,
so maxMinutes must be null there, not a guessed number. Only set maxMinutes when the user actually gave a
time or distance limit. modes defaulting to both WALK and TRANSIT when unspecified is not a guess about
the search itself, just a reasonable default for a missing preference.

Whenever confident is false, also write clarifyingQuestion: a short, specific, friendly question asking
for exactly whatever made you unable to search — usually the category ("What kind of place are you
after?"), but ask about whatever is actually missing or too vague to act on. Don't ask about anything
that's already fine (e.g. don't ask about time budget just because none was given — that's a legitimate
default, not something missing). One focused question, not a list of them.

The user may also mention a starting point other than where they physically are right now (e.g. "I'll be
at Britomart tomorrow") and/or a future day and time. Extract these exactly as separate fields — do not
fold them into the category. You do not compute an actual date yourself; just extract what was said
(a day word, an hour, a minute) as plain fields, in the user's own stated terms. Leave a field null
whenever the user didn't actually state that part, rather than guessing a value for it.

A vague time-of-day word — "morning", "lunch"/"midday"/"noon", "afternoon", "evening", "dinner",
"tonight"/"night" — is still something the user stated, so extract a representative hour for it rather
than leaving hour null: morning→9, lunch/midday/noon→12, afternoon→15, evening→18, dinner→19,
tonight/night→20 (minute 0 in each case). This isn't inventing a time they didn't give — the actual
routing and opening-hours check downstream need a concrete hour, and leaving it null when a day was
named would silently check against whatever moment the request happens to arrive at, which is never what
"Friday evening" means. Only leave hour and minute null when the user gave no time reference of any kind.

You may be given a "Previous request" as extra context — that's what was extracted from the user's last
message, not something they just said. Decide whether the new message is a follow-up refinement of it or
a fresh, independent request:
- If the new message reads as a complete request on its own (it names its own category, even without a
  time/place), ignore the previous request entirely and extract only from the new message.
- If the new message reads as a small correction with no category of its own (e.g. "actually walking
  only", "make it tomorrow instead", "closer to the station"), it's a refinement — reuse whatever the
  previous request had for any field the new message doesn't address, and change only what it does.
- If the previous request had confident: false (you'd asked a clarifying question), the new message is
  almost always the user directly answering it — e.g. just "sushi" answering "what kind of food?". Treat
  it as supplying whatever was missing, keep any other fields the previous request already had, and set
  confident based on whether the combined result is now actually usable.

You are not choosing a place, a route, or a travel time — those come from real map data elsewhere.
Your only job is turning the sentence into a search.`;

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
  const previousIntentResult = NearbyQuerySchema.omit({ clarifyingQuestion: true }).safeParse(previousIntentRaw);
  const previousIntent = previousIntentResult.success ? previousIntentResult.data : null;

  try {
    const userContent = previousIntent
      ? `Previous request (context only, not something the user just said): ${JSON.stringify(previousIntent)}\n\nNew message: "${text}"`
      : text;
    const response = await client.beta.messages.parse({
      model: 'claude-opus-5-5',
      max_tokens: 1024,
      system: PARSE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
      output_format: betaZodOutputFormat(NearbyQuerySchema),
    });

    if (!response.parsed_output) {
      return jsonResponse({ error: 'Could not parse a query from that text' }, 422);
    }
    return jsonResponse(response.parsed_output);
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
