// --- Result Explanation & Question Answering ---
// The written half of the chat, both via Claude and both only ever describing results the app already
// computed from real Places/Routes data — they explain or compare what they're handed and never add a
// place or a fact:
//  - POST /explain-results: a short reply to a search, written once its results are in.
//  - POST /answer-question: an answer to a follow-up about results already on screen ("which is best
//    rated?"), with no new search behind it.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { handleAnthropicError, jsonResponse, MAX_TEXT_LENGTH, readJsonBody } from './http';

const MAX_RESULTS = 10;

// Kept on Opus on purpose: Haiku 5.5 and Sonnet 5.5 answered a Korean question in English, even with
// an explicit reply-in-the-user's-language rule, and the reply is what the user reads.
const REPLY_MODEL = 'claude-opus-5-5';
// Opus 5.5 always thinks first, and that hidden reasoning shares this budget — at 300 the reply came
// back empty or cut off mid-sentence. The visible reply is only a few sentences.
const REPLY_MAX_TOKENS = 2000;

// --- Results Payload ---
// Strings from Places are trimmed to a sane length rather than rejected — a long editorial summary
// shouldn't turn a perfectly good search into an error.
const clipped = (max: number) => z.string().transform((value) => value.slice(0, max));

const ResultSchema = z.object({
  name: clipped(100),
  durationMinutes: z.number(),
  mode: z.enum(['WALK', 'TRANSIT']),
  routeShortName: clipped(20).optional(),
  rating: z.number().optional(),
  userRatingCount: z.number().optional(),
  editorialSummary: clipped(400).optional(),
  // Judged at departure + travel time, not at departure (see withArrivalHours).
  isOpenOnArrival: z.boolean().optional(),
  // Only present when it is open on arrival but closes within the hour after.
  closesInMinutes: z.number().optional(),
  // 0 (free) to 4 (very expensive); each detail is only present when Places actually knows it.
  priceLevel: z.number().optional(),
  servesVegetarianFood: z.boolean().optional(),
  outdoorSeating: z.boolean().optional(),
  todayHoursText: clipped(200).optional(),
});
type Result = z.infer<typeof ResultSchema>;

// numbered lists get "1." markers so "the second one" has an unambiguous meaning to point at.
function formatResults(results: Result[], numbered: boolean): string {
  if (results.length === 0) return '(no results found)';
  return results
    .map((r, index) => {
      const travel = r.mode === 'WALK' ? `${r.durationMinutes} min walk` : `${r.durationMinutes} min via ${r.routeShortName ?? 'transit'}`;
      const rating = r.rating != null ? `, rated ${r.rating}★${numbered && r.userRatingCount != null ? ` (${r.userRatingCount} reviews)` : ''}` : '';
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
      return `${numbered ? `${index + 1}.` : '-'} ${r.name}: ${travel}${rating}${details}${hours}${summary}`;
    })
    .join('\n');
}

async function writeReply(client: Anthropic, system: string, content: string): Promise<string> {
  const response = await client.messages.create({
    model: REPLY_MODEL,
    max_tokens: REPLY_MAX_TOKENS,
    system,
    messages: [{ role: 'user', content }],
  });
  return response.content.find((block) => block.type === 'text')?.text ?? '';
}

// --- Explain Results ---
const ExplainRequestSchema = z.object({
  query: z.string(),
  // False when the user's text gave no day/time at all — the results then weren't filtered by
  // opening hours (see nearbySearch.ts), so some may be closed by the time the user gets there.
  // True means they did give a time, and the results are already confirmed open on arrival.
  hadExplicitTime: z.boolean(),
  // How the (already ordered) results were ranked — closest first, or best rated first.
  rankedBy: z.enum(['nearest', 'best']).default('nearest'),
  results: z.array(ResultSchema),
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

export async function handleExplainResults(request: Request, client: Anthropic): Promise<Response> {
  const read = await readJsonBody(request);
  if ('error' in read) return read.error;
  const validated = ExplainRequestSchema.safeParse(read.body);
  if (!validated.success) return jsonResponse({ error: 'Invalid request body' }, 400);
  const parsed = validated.data;
  if (!parsed.query.trim()) {
    return jsonResponse({ error: '"query" is required' }, 400);
  }
  if (parsed.query.length > MAX_TEXT_LENGTH) {
    return jsonResponse({ error: `"query" must be under ${MAX_TEXT_LENGTH} characters` }, 400);
  }
  // The client already caps how many results it routes, but this guards the prompt itself
  // against an unexpectedly large payload regardless of what the caller sends.
  const results = parsed.results.slice(0, MAX_RESULTS);

  try {
    const reply = await writeReply(
      client,
      EXPLAIN_SYSTEM_PROMPT,
      `User's question: "${parsed.query}"\nhadExplicitTime: ${parsed.hadExplicitTime}\nrankedBy: ${parsed.rankedBy}\n\nActual results found:\n${formatResults(results, false)}`
    );
    return jsonResponse({ reply });
  } catch (err) {
    return handleAnthropicError(err, 'Result explanation');
  }
}

// --- Answer Question ---
const AnswerRequestSchema = z.object({
  question: z.string(),
  results: z.array(ResultSchema).min(1),
  // The last few chat messages, oldest first — enough to resolve "that one" or "and the other?".
  recentTurns: z
    .array(z.object({ role: z.enum(['user', 'assistant']), text: clipped(600) }))
    .max(6)
    .default([]),
});

const ANSWER_SYSTEM_PROMPT = `You answer a user's follow-up questions about places a transit app's nearby-places chat has already shown them.

You're given the ACTUAL results on their screen, numbered in the order they see them (so "the second one"
is entry 2), with the real details the app has: travel time, rating and review count, price level,
vegetarian and outdoor-seating details, and opening hours judged for when they would arrive. You may also
be given the last few chat messages for context.

Answer the question directly in one to three sentences, using ONLY that data. Plain text only: no
markdown, no bold or asterisks — your reply is shown exactly as written. Reply in the same language the
question is written in (Korean question, Korean reply).

Refer to places by name — never by entry number or as "entry". Never invent a detail. If the data doesn't answer the question (a menu, whether a place takes bookings,
anything not listed), say plainly that it isn't known here and point them to the "View on Google Maps" link
on that place. A detail that isn't listed is simply unknown — never say a place lacks it, or has it.
When you compare, name the place and say why. For "cheapest", "best rated" and "closest" use price level,
rating and travel time respectively; weigh the review count (a 5.0 from three reviews isn't clearly better
than a 4.8 from hundreds); if places tie, say so rather than picking one arbitrarily.`;

export async function handleAnswerQuestion(request: Request, client: Anthropic): Promise<Response> {
  const read = await readJsonBody(request);
  if ('error' in read) return read.error;
  const validated = AnswerRequestSchema.safeParse(read.body);
  if (!validated.success) return jsonResponse({ error: 'Invalid request body' }, 400);
  const parsed = validated.data;
  if (!parsed.question.trim()) {
    return jsonResponse({ error: '"question" is required' }, 400);
  }
  if (parsed.question.length > MAX_TEXT_LENGTH) {
    return jsonResponse({ error: `"question" must be under ${MAX_TEXT_LENGTH} characters` }, 400);
  }
  const results = parsed.results.slice(0, MAX_RESULTS);
  const recent =
    parsed.recentTurns.length > 0
      ? `Recent chat:\n${parsed.recentTurns.map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`).join('\n')}\n\n`
      : '';

  try {
    const reply = await writeReply(
      client,
      ANSWER_SYSTEM_PROMPT,
      `${recent}Results on screen:\n${formatResults(results, true)}\n\nUser's question: "${parsed.question}"`
    );
    return jsonResponse({ reply });
  } catch (err) {
    return handleAnthropicError(err, 'Answering');
  }
}
