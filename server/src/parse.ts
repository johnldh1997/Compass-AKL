// --- Nearby Query Parsing ---
// The model-facing half of POST /parse-nearby: the schema the model must fill in, the system
// prompt that tells it how, and the one function that makes the call. Kept apart from the
// Worker's request handling (index.ts) so the eval harness (eval/run.ts) can run the exact same
// prompt, schema and call path against a test set, with no HTTP server in between.
//
// A message is one of three things (messageKind): a search for places (the original job, including
// every refinement of the previous search), a question about the results already on screen, or an
// action on one of them ("take me to the second one"). The model only classifies and extracts —
// answering a question is /answer-question's job (explain.ts), and acting is the app's.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

// Google Places place types a search can be anchored to (all checked against the live Places API). Offering
// the model a closed list means it can only name a type Google accepts. See placeType in the schema below.
export const PLACE_TYPES = [
  'american_restaurant', 'bakery', 'bar', 'barbecue_restaurant', 'breakfast_restaurant', 'brunch_restaurant',
  'cafe', 'chinese_restaurant', 'coffee_shop', 'dessert_shop', 'fast_food_restaurant', 'french_restaurant',
  'greek_restaurant', 'hamburger_restaurant', 'ice_cream_shop', 'indian_restaurant', 'italian_restaurant',
  'japanese_restaurant', 'korean_restaurant', 'mexican_restaurant', 'middle_eastern_restaurant', 'pizza_restaurant',
  'ramen_restaurant', 'sandwich_shop', 'seafood_restaurant', 'steak_house', 'sushi_restaurant', 'thai_restaurant',
  'turkish_restaurant', 'vegan_restaurant', 'vegetarian_restaurant', 'vietnamese_restaurant', 'pharmacy', 'supermarket',
  'convenience_store', 'gym', 'atm', 'bank', 'gas_station', 'park', 'library', 'museum', 'shopping_mall', 'book_store',
  'liquor_store', 'post_office', 'tourist_attraction',
] as const;

export const TARGET_DAYS =['today', 'tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

export const NearbyQuerySchema = z.object({
  // First on purpose: the model fills fields in order, so it decides what kind of message this is
  // before it starts extracting search parameters from it.
  messageKind: z
    .enum(['search', 'question', 'action'])
    .describe(
      "What the user is doing. 'search': asking for places, including any follow-up that changes the search (a new place, time, limit or preference). 'question': asking about the results currently shown (which is best rated or cheapest, whether one is open or vegetarian, how far one is) without wanting a new search. 'action': asking the app to do something with one of the shown results (take me there, directions, show it on the map). Always 'search' when no results are currently shown."
    ),
  category: z
    .string()
    .describe(
      "A short search phrase for Google Places, e.g. 'Japanese restaurant' or 'coffee shop'. Empty string if no category is identifiable."
    ),
  placeType: z
    .enum(['none', ...PLACE_TYPES])
    .describe(
      "When what they want is a KIND of place that Google files under one of these types, that type — 'burger place' is hamburger_restaurant (Google files McDonald's, Burger King and Carl's Jr there too), 'pizza' is pizza_restaurant, 'ramen' is ramen_restaurant, 'coffee' is coffee_shop, 'chemist' is pharmacy. 'none' for a specific brand or shop name ('McDonald's', 'Starbucks', 'yogost', 'gong cha'), a dish or specialty with no type of its own, or anything not listed — those are found by name through the category phrase instead."
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
    .describe(
      "Which travel modes are acceptable. Default to both if the user did not specify. Only WALK when they said they'd walk or go on foot ('walking', 'on foot', '걸어서', or the equivalent in any language); only TRANSIT when they named a bus, train, ferry or public transport."
    ),
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
      "Which day the user means, only if they actually said one: 'today', 'tomorrow', or a weekday name. Null if they mentioned no day at all — assume right now. A request for places that are open right now ('open now', 'currently open', or the equivalent in any language) is 'today' with hour and minute null: that makes the app check opening hours for when the user would arrive."
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
  rankBy: z
    .enum(['nearest', 'best'])
    .describe(
      "'best' only when the user explicitly asked for quality — best, top rated, highest rated, most popular, recommended, tastiest, or the equivalent in any language. Everything else, including 'closest', 'nearest', 'near me', and no preference at all, is 'nearest'."
    ),
  wantsCheap: z
    .boolean()
    .describe("True only if the user asked for cheap / budget / affordable / inexpensive. False otherwise — never guessed."),
  wantsVegetarian: z
    .boolean()
    .describe('True only if the user asked for vegetarian or vegan food. False otherwise — never guessed.'),
  wantsOutdoorSeating: z
    .boolean()
    .describe("True only if the user asked for outdoor seating — a patio, terrace, garden, 'al fresco', 'sit outside'. False otherwise — never guessed."),
  savedPlaceLabel: z
    .string()
    .describe(
      "When the user starts from one of their saved places ('near work', 'by my gym', '회사 근처'): the label of that saved place, exactly as it appears in the saved places list. Empty string if they didn't refer to a saved place. When set, referenceLocationText must be null."
    ),
  useJourneyDestination: z
    .boolean()
    .describe(
      "True if the user means where their planned trip ends — 'near my stop', 'where I get off', 'at my destination', 'when I arrive', or the equivalent in any language. False otherwise. When true, referenceLocationText must be null."
    ),
  actionType: z
    .enum(['none', 'directions', 'maps'])
    .describe(
      "For messageKind 'action': 'directions' (take me there, navigate, directions to it) or 'maps' (show it on the map, open it in Google Maps). 'none' for a search or a question."
    ),
  actionTargetIndex: z
    .number()
    .int()
    .min(0)
    .max(10)
    .describe(
      "For messageKind 'action': the 1-based position, in the numbered shown-results list, of the result they mean — 'the second one' is 2; 'the cheapest' or a name means working out which entry that is from the list. 0 if it isn't clear which one (more than one could fit) or this isn't an action."
    ),
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

export const PARSE_SYSTEM_PROMPT = `You extract structured search parameters from a transit app user's free-text request for nearby places.

The text is casual, spoken-style input — expect missing punctuation and informal phrasing (e.g. "japanese
food" means Japanese restaurant). An unfamiliar word is not necessarily a typo — it may be the name of a
real shop, brand, or chain you don't recognize (e.g. a specific drink or dessert shop name); when the text
reads as a proper name for a place, pass it through as-is rather than "correcting" it to a generic food
type, since Google Places can look up specific brand names directly. Only fix a word when it's clearly a
garbled version of an ordinary word with no plausible reading as a name; when in doubt keep the user's own
spelling — Google Places forgives misspellings, so keeping it loses nothing, while "correcting" a shop or
brand name into a generic category (a name that looks like a misspelled "yogurt" becoming a search for
yogurt shops in general) loses the one place they actually asked for. Only set confident to false and
leave category empty when the category is genuinely ambiguous or entirely absent from the text — not
merely because it's informally worded or an unfamiliar name. A bare reference to food or a place to eat
with no further qualifier at all — no cuisine, no dish, no specific business type or name (e.g. "somewhere
to eat", "a place to eat", "food", "restaurant", or the equivalent in any language) — counts as absent, not
identified: set confident to false and ask what kind of food or place they're after, same as any other
missing category. A meal word — "breakfast", "brunch", "lunch", "dinner" — is different: it names what they
want to do, so "dinner near my stop" or "healthy lunch near work" is a confident search with category
"restaurant" (a cafe, for breakfast or brunch). Apply this exact same bar regardless of which language the request is phrased in — the
same degree of vagueness must get the same treatment whether it's asked in English, Korean, or otherwise;
don't let one language's phrasing read as more specific than an equivalent phrasing in another. Never invent a category, time budget, or
travel mode that has no basis in the text at all — a plain "closest X" or "nearest X" has no time budget,
so maxMinutes must be null there, not a guessed number. Only set maxMinutes when the user actually gave a
time or distance limit. A stated distance counts as a limit: convert it at about 12 minutes of walking per
kilometre ("within 1km" is 12, "500m" is 6), rounded to a whole minute. modes defaulting to both WALK and TRANSIT when unspecified is not a guess about
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

rankBy, wantsCheap, wantsVegetarian and wantsOutdoorSeating are preferences about which places to show and
in what order — they are applied afterwards to real Google Places data (ratings, price level, menu and
seating details), so you never judge a place yourself. Set them only when the user actually said so, and
leave the defaults (rankBy 'nearest', the rest false) otherwise. "Best" and "cheap" are not part of the
category: "best ramen" is category ramen with rankBy 'best'. A dietary word that names the kind of place
may stay in the category ("vegetarian restaurant") as well as setting wantsVegetarian. A dietary
requirement (vegetarian, vegan) is itself specific enough to search ("vegetarian restaurant"), even with
only a generic word like "lunch" or "food" beside it, so "cheap vegetarian lunch" is confident — but
"cheap" or "best" on its own, with no food or place at all, is still a missing category.

placeType travels with category: it names Google's own type for the kind of place being asked for, so the app
can ask Google for everything filed under it ("burger place" finds McDonald's and Carl's Jr as well as shops
with "burger" in their name). Only use it for a kind of place; a brand or a specific shop stays a name in the
category with placeType 'none'. A refinement that keeps the previous category keeps its placeType too.

Besides searching, a message can be about the results already on screen. They are given to you as
"Results currently shown to the user", a numbered list. Decide messageKind:
- "question": asks something about those results — "which is best rated?", "is the first one vegetarian?",
  "how far is Oodles?", "what time does the second one close?", "which are open now?" — and wants an answer,
  not a new search.
- "action": asks the app to do something with one of them — "take me to the second one", "directions to
  Oodles", "show the cheapest on the map". Set actionType, and actionTargetIndex to the number of the entry
  they mean, working it out from the list when they describe it ("the cheapest", "the closest", a name). If
  more than one entry could fit and nothing in the message settles it ("take me there"), set
  actionTargetIndex 0, confident false and ask which one in clarifyingQuestion.
- "search": everything else, including any follow-up that changes what is being searched for — a new
  place, time, limit or preference ("walking only", "open now", "best rated", "cheaper ones", "what about
  sushi instead?"). A short preference with no question in it is a refinement, not a question.
When no results are shown, messageKind is always "search". For a question or an action the search fields are
not used: copy them from the previous request if there is one, otherwise leave the defaults (empty
category, both modes, nulls, rankBy 'nearest', false flags, empty savedPlaceLabel), and set confident true
unless an action is ambiguous as described above.

The user's saved places may be listed ("Saved places"). When they start from one of them by name or
nickname — "near work", "by the gym", "회사 근처" — that is a personal reference, not a public place name:
set savedPlaceLabel to that entry's label exactly as listed, matching across languages and synonyms ("회사"
and "the office" both mean a saved "Work"), and leave referenceLocationText null. If they refer to a
personal place of their own ("work", "my gym", "mum's place") that is not in the list, you can't search
near it: set confident false and write a clarifyingQuestion saying it isn't saved yet and that they can add
it under Favourites and give it that name. Never quietly search around where they are instead: "near work"
means near work, so with no saved work the answer is that question, not a search. A named public place ("Britomart", "the airport", "Sky Tower")
is never a saved place — that stays referenceLocationText.

If they mean where their planned trip ends — "near my stop", "where I get off", "at my destination",
"when I arrive", "open when I get there" — set useJourneyDestination true and leave referenceLocationText
null. Their arrival time is what the search is for, so a meal or time-of-day word here only says what they
want to eat ("dinner near my stop" is a restaurant search, with hour and minute left null) — only a clock
time ("at 8pm") or a day word counts as a time they stated.

You may be given a "Previous request" as extra context — that's what was extracted from the user's last
message, not something they just said. Decide whether the new message is a follow-up refinement of it or
a fresh, independent request:
- If the new message reads as a complete request on its own (it names its own category, even without a
  time/place), ignore the previous request entirely and extract only from the new message.
- If the new message reads as a small correction with no category of its own (e.g. "actually walking
  only", "make it tomorrow instead", "closer to the station"), it's a refinement — reuse whatever the
  previous request had for any field the new message doesn't address, and change only what it does. A
  message that only adds a preference — cheap, vegetarian, outdoor seating, walking only, open now, best
  rated, closest, a time limit — is a refinement even when its words could also name a kind of place
  ("places with vegetarian options" adds wantsVegetarian to the previous category; it is not a new search
  for vegetarian restaurants).
- If the previous request had confident: false (you'd asked a clarifying question), the new message is
  almost always the user directly answering it — e.g. just "sushi" answering "what kind of food?". Treat
  it as supplying whatever was missing, keep any other fields the previous request already had, and set
  confident based on whether the combined result is now actually usable.

You are not choosing a place, a route, or a travel time — those come from real map data elsewhere.
Your only job is turning the sentence into a search.`;

export type NearbyQuery = z.infer<typeof NearbyQuerySchema>;

// What a follow-up turn is given as context: the last turn's result without its clarifying
// question (the model already knows what it asked without seeing it echoed back). confident is
// kept — it's how the model tells a refinement apart from an answer to its own question.
// The preference fields default when absent, so a follow-up still works when the previous turn was
// parsed before they existed (e.g. a chat saved on the phone by an older version of the app).
export const PreviousIntentSchema = NearbyQuerySchema.omit({
  clarifyingQuestion: true,
  messageKind: true,
  actionType: true,
  actionTargetIndex: true,
}).extend({
  placeType: NearbyQuerySchema.shape.placeType.default('none'),
  savedPlaceLabel: z.string().default(''),
  useJourneyDestination: z.boolean().default(false),
  rankBy: NearbyQuerySchema.shape.rankBy.default('nearest'),
  wantsCheap: z.boolean().default(false),
  wantsVegetarian: z.boolean().default(false),
  wantsOutdoorSeating: z.boolean().default(false),
});
export type PreviousIntent = z.infer<typeof PreviousIntentSchema>;

// Chosen with the eval (npm run eval): Opus 5.5, Sonnet 5.5 and Haiku 5.5 all passed every case, and Haiku
// answers about a third faster at roughly 1/40th of Opus's cost per search. Re-run the eval before moving it.
export const PARSE_MODEL = 'claude-haiku-5-5';

// --- Parse Context ---
// What the app knows that changes how a message should be read: the results on screen (so "take me to
// the second one" has something to point at) and the user's saved places (so "near work" can be matched).
// Both come from the client, so both are validated like any request body, and a bad one is dropped.
export const ShownResultSchema = z.object({
  name: z.string().transform((value) => value.slice(0, 100)),
  minutes: z.number(),
  mode: z.enum(['WALK', 'TRANSIT']),
  route: z.string().transform((value) => value.slice(0, 20)).optional(),
  rating: z.number().optional(),
  ratingCount: z.number().optional(),
  priceLevel: z.number().optional(),
  vegetarian: z.boolean().optional(),
  outdoorSeating: z.boolean().optional(),
  hours: z.enum(['open', 'closes soon', 'closed']).optional(),
});
export type ShownResult = z.infer<typeof ShownResultSchema>;

export const MAX_SHOWN_RESULTS = 10;
export const MAX_SAVED_PLACES = 30;

export interface ParseContext {
  previousIntent?: PreviousIntent | null;
  shownResults?: ShownResult[];
  // undefined means the client didn't say (an older app); [] means it did, and there are none.
  savedPlaces?: string[];
}

function describeShownResult(r: ShownResult, position: number): string {
  const travel = r.mode === 'WALK' ? `${r.minutes} min walk` : `${r.minutes} min via ${r.route ?? 'transit'}`;
  const facts = [
    travel,
    r.rating != null ? `${r.rating}★${r.ratingCount != null ? ` (${r.ratingCount} reviews)` : ''}` : null,
    r.priceLevel != null && r.priceLevel >= 1 ? '$'.repeat(r.priceLevel) : null,
    r.vegetarian ? 'vegetarian options' : null,
    r.outdoorSeating ? 'outdoor seating' : null,
    r.hours ? `${r.hours} on arrival` : null,
  ].filter(Boolean);
  return `${position}. ${r.name} — ${facts.join(', ')}`;
}

export function buildParseUserContent(text: string, context: ParseContext = {}): string {
  const { previousIntent = null, shownResults = [], savedPlaces } = context;
  const sections: string[] = [];
  if (previousIntent) {
    sections.push(`Previous request (context only, not something the user just said): ${JSON.stringify(previousIntent)}`);
  }
  if (shownResults.length > 0) {
    sections.push(
      `Results currently shown to the user (numbered, in order):\n${shownResults.map((r, i) => describeShownResult(r, i + 1)).join('\n')}`
    );
  }
  if (savedPlaces !== undefined) {
    sections.push(`Saved places: ${savedPlaces.length > 0 ? JSON.stringify(savedPlaces) : '(none saved)'}`);
  }
  if (sections.length === 0) return text;
  return `${sections.join('\n\n')}\n\nNew message: "${text}"`;
}

// parsed is null when the model produced nothing matching the schema.
export async function parseNearbyIntent(
  client: Anthropic,
  text: string,
  context: ParseContext = {},
  model: string = PARSE_MODEL
) {
  const response = await client.beta.messages.parse({
    model,
    max_tokens: 1024,
    system: PARSE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildParseUserContent(text, context) }],
    output_format: betaZodOutputFormat(NearbyQuerySchema),
  });
  return { parsed: response.parsed_output, usage: response.usage };
}
