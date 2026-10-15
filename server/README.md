# Nearby Search Query Proxy

A Cloudflare Worker that holds the app's secrets and makes the calls that need them. The Find Nearby chat
uses three model endpoints, and every Google Places and Routes call the app makes goes through five more:

- `POST /parse-nearby` — reads a chat message ("European food near Britomart tomorrow at 5pm", in
  English or Korean) and says what it is: a **search**, a **question** about the results already on
  screen, or an **action** on one of them ("take me to the second one"). For a search it returns
  structured intent: category, a stated time budget, travel modes, whether it means the app's saved
  home address, a saved place by name ("near work"), where the user's planned trip ends ("near my
  stop"), a named reference location, a target day/hour/minute, Google's own place type for the kind of place asked for (`hamburger_restaurant` for "burger place"; `none` for a brand or a shop name), closest or best rated, cheap /
  vegetarian / outdoor-seating asks, and — when the request is too vague to act on — a clarifying
  question to ask back. Besides `text` it accepts three optional pieces of context, each validated
  and dropped if malformed: `previousIntent` (so "actually walking only" reads as a refinement),
  `shownResults` (a compact numbered list, so an action can point at "the second one"; the model's
  number is a claim the app checks) and `savedPlaces` (names the user has given places).
- `POST /explain-results` — takes the client's own already-computed real results (places, real
  travel times, ratings, hours at the moment of arrival, price and menu details) and writes a short
  reply in the user's language. Never invents a place, distance, or detail that isn't in the list
  it's given. Runs on Opus 5.5 because the smaller models answered Korean questions in English;
  Opus always thinks before answering, so it gets a generous `max_tokens` (at 300 the reply came
  back empty or cut off).
- `POST /answer-question` — the same, for a follow-up about results already on screen ("which is
  best rated?", "what time does the second one close?"): the numbered results plus the last few chat
  turns in, a one-to-three sentence answer out, from that data only. A detail that isn't listed is
  "not known here", never a guess.

- `POST /google/autocomplete`, `/google/search-text`, `/google/search-nearby`, `/google/place-location`,
  `/google/route` — the app's Google Places and Routes calls, made from here so the key that can do them
  never ships in the app (`src/google.ts`). This is a narrow door, not a pass-through: each endpoint takes
  only the few fields the app sends (validated, with caps on text length, radius and result count), builds
  the Google request itself, and fixes the field mask — so a caller can't ask for a pricier Google tier than
  the app does, can't reach a Google endpoint that isn't listed, and can't smuggle a path into a place id.
  `route` takes a *profile* (`journey-transit`, `journey-walk`, `candidate-walk`, `candidate-transit`), each
  with its own travel mode and field mask. Google's error text is never passed on (it can name the key's
  project and settings) — only the status. `src/google.spec.ts` tests what may reach Google (`npm test`).

No model endpoint ever picks a place, a route, or a travel time itself, and none computes an actual date
— those come from real Google Places/Routes data and pure date-math, both handled client-side in
`../src/services/nearbySearch.ts`, `nearbyRanking.ts` and `nearbyConversation.ts`. Code layout:
`src/parse.ts` (the message-reading prompt and schema), `src/explain.ts` (explain + answer),
`src/limits.ts` (abuse protection), `src/http.ts` (shared helpers), `src/index.ts` (routing). See
the Zod schemas and system prompts there for the exact contract.

## Why this exists as a separate service

A React Native app bundle can't hold a secret safely — there's no equivalent of Google's
package-name + SHA1 key restriction for an Anthropic key, so it can't be embedded client-side
the way the app's existing AT/Google keys are. This Worker is the only place the Anthropic key
lives.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
# edit .dev.vars and set ANTHROPIC_API_KEY and GOOGLE_API_KEY (Places API (New) + Routes API only)
npm run dev
```

```bash
curl -X POST http://localhost:8787/parse-nearby \
  -H "Content-Type: application/json" \
  -d '{"text": "Japanese food within 20 minutes"}'
```

A refinement follow-up, giving the previous turn's own parsed result as context:

```bash
curl -X POST http://localhost:8787/parse-nearby \
  -H "Content-Type: application/json" \
  -d '{"text": "actually only walking", "previousIntent": {"category":"Japanese restaurant","maxMinutes":20,"modes":["WALK","TRANSIT"],"useSavedHome":false,"referenceLocationText":null,"targetDay":null,"hour":null,"minute":null,"confident":true}}'
```

## Testing the parser

`npm run eval` runs about 140 English and Korean phrasings (plain searches, time limits, saved home,
named places, days and vague times of day, too-vague requests, follow-up refinements, brand names,
questions and actions on results shown, saved places, "near my stop")
through the same prompt, schema and call the Worker uses, and checks each structured result field
by field. It needs the key in `.dev.vars` and makes one real API call per case.

```bash
npm run eval                                    # the model the Worker uses
npm run eval -- --model claude-sonnet-5-5       # try another model
npm run eval -- --filter ko-                    # only cases whose id contains "ko-"
npm run eval -- --repeat 5                      # each case 5 times — the model isn't deterministic
```

Run it before changing the prompt, the schema or the model: a rule tightened for one phrasing can
quietly break another, and this is where that shows up. Cases live in `eval/cases.json`; a case only
checks the fields it lists under `expect`.

## Deploying

```bash
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GOOGLE_API_KEY
npm run deploy
```

## Notes

- **Abuse protection is rate limiting, not authentication** (`src/limits.ts`). The app sends a random
  per-install id in `X-Install-Id`; a request with a well-formed one is counted against that install
  (`INSTALL_LIMITER`, 16/min) and, at a looser ceiling, its IP (`IP_LIMITER`, 50/min) so a shared network
  isn't one caller. One without is counted against its IP alone (`ANON_LIMITER`, 8/min), so leaving the
  header off buys a worse limit, not a better one. The Google endpoints get their own three limiters
  (`GOOGLE_*`, 60 / 100 / 20 a minute) because one Find Nearby search makes about ten Google calls and
  autocomplete fires as you type, so they'd otherwise starve the model endpoints' much smaller allowance. The id is not a secret — a script can mint fresh ones —
  and these are Cloudflare Rate Limiting bindings, which are per location and eventually consistent (a
  burst of 26 requests let 17 through, not exactly 16). They blunt bursts; they don't meter. The hard
  backstop on spend is the cap on the Anthropic key. Bodies over 32,000 characters get a 413 before any
  parsing. Real app attestation (Play Integrity / App Attest) would close the rest, but needs a native
  build and Google-side setup, and isn't done.
- **What the Worker is sent, and what it keeps.** The message text, the previous parsed intent, the shown
  results (names, ratings, hours, price) and the user's own names for saved places — never GPS position
  or the home address. It stores nothing and logs only unexpected errors; the text and results are
  forwarded to Anthropic's API to be read and answered.
- **The model only ever extracts intent.** `/parse-nearby`'s fields are structured output via
  Zod (`betaZodOutputFormat`) — the schema and system prompt are written so the model can't
  return a specific place, distance, duration, or computed date, even if asked to; `/explain-results`
  is handed the app's own already-computed real results and can only describe them.
