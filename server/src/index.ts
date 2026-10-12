// --- Nearby Chat Worker ---
// Three endpoints, all via Claude, all text-only:
//  - POST /parse-nearby: a chat message (plus the results on screen and the user's saved place names)
//    -> what kind of message it is and, for a search, the structured search intent (category, time
//    budget, a named reference location, a target day/time). See parse.ts.
//  - POST /explain-results: the client's own already-computed real results -> a short written reply.
//  - POST /answer-question: a follow-up question about results already on screen -> a short answer.
//    See explain.ts for both.
// None of them ever picks a place, route, or time itself — that's real Places/Routes data, computed
// client-side (see src/services/nearbySearch.ts); they classify, extract, or describe what they're given.
// This is also the only place the Anthropic API key ever lives — a React Native bundle can't hold a
// secret safely, since there's no equivalent of Google's package-name+SHA1 key restriction for it.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { handleAnswerQuestion, handleExplainResults } from './explain';
import { handleAnthropicError, jsonResponse, MAX_TEXT_LENGTH, readJsonBody } from './http';
import { checkRateLimits, LimitBindings } from './limits';
import { MAX_SAVED_PLACES, MAX_SHOWN_RESULTS, parseNearbyIntent, PreviousIntentSchema, ShownResultSchema } from './parse';

export interface Env extends LimitBindings {
  ANTHROPIC_API_KEY: string;
}

const ShownResultsSchema = z.array(ShownResultSchema).max(MAX_SHOWN_RESULTS);
const SavedPlacesSchema = z.array(z.string().transform((value) => value.slice(0, 60))).max(MAX_SAVED_PLACES);

async function handleParseNearby(request: Request, client: Anthropic): Promise<Response> {
  const read = await readJsonBody(request);
  if ('error' in read) return read.error;
  const body = (read.body ?? {}) as { text?: unknown; previousIntent?: unknown; shownResults?: unknown; savedPlaces?: unknown };
  const { text } = body;
  if (typeof text !== 'string' || !text.trim()) {
    return jsonResponse({ error: '"text" is required' }, 400);
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return jsonResponse({ error: `"text" must be under ${MAX_TEXT_LENGTH} characters` }, 400);
  }
  // Everything beyond the text is client-supplied, so each piece is validated like a fresh request body
  // — and an invalid or absent one just means this message is read without that context, not an error,
  // since all of them are optional by nature. For previousIntent, confident is kept (the model needs it
  // to tell a refinement apart from an answer to its own clarifying question); the question text itself
  // isn't, since the model already knows what it asked without seeing it echoed back.
  const previousIntentResult = PreviousIntentSchema.safeParse(body.previousIntent);
  const shownResultsResult = ShownResultsSchema.safeParse(body.shownResults);
  const savedPlacesResult = SavedPlacesSchema.safeParse(body.savedPlaces);

  try {
    const { parsed } = await parseNearbyIntent(client, text, {
      previousIntent: previousIntentResult.success ? previousIntentResult.data : null,
      shownResults: shownResultsResult.success ? shownResultsResult.data : [],
      savedPlaces: savedPlacesResult.success ? savedPlacesResult.data : undefined,
    });

    if (!parsed) {
      return jsonResponse({ error: 'Could not parse a query from that text' }, 422);
    }
    return jsonResponse(parsed);
  } catch (err) {
    return handleAnthropicError(err, 'Query parsing');
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Only POST is supported' }, 405);
    }
    const { pathname } = new URL(request.url);
    if (pathname !== '/parse-nearby' && pathname !== '/explain-results' && pathname !== '/answer-question') {
      return jsonResponse({ error: 'Not found' }, 404);
    }

    const limited = await checkRateLimits(request, env);
    if (limited) return limited;

    if (!env.ANTHROPIC_API_KEY) {
      return jsonResponse({ error: 'Server misconfigured: ANTHROPIC_API_KEY is not set' }, 500);
    }
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

    if (pathname === '/parse-nearby') return handleParseNearby(request, client);
    if (pathname === '/explain-results') return handleExplainResults(request, client);
    return handleAnswerQuestion(request, client);
  },
};
