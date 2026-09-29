# Nearby Search Query Proxy

A two-endpoint Cloudflare Worker behind the app's "Find Nearby" chat feature:

- `POST /parse-nearby` — turns free text ("European food near Britomart tomorrow at 5pm", in
  English or Korean) into structured search intent: category, a stated time budget, travel
  modes, whether it means the app's saved home address, a named reference location, a target
  day/hour/minute, and — when the request is too vague to act on — a clarifying question to ask
  back. Accepts an optional `previousIntent` so a short follow-up ("actually walking only") is
  understood as a refinement of the last turn rather than its own incomplete request.
- `POST /explain-results` — takes the client's own already-computed real results (places, real
  travel times, ratings, hours) and writes a short natural-language reply. Never invents a
  place, distance, or detail that isn't in the list it's given.

Neither endpoint ever picks a place, a route, or a travel time itself, and neither computes an
actual date — those come from real Google Places/Routes data and pure date-math, both handled
client-side in `../src/services/nearbySearch.ts` and `../src/services/nearbyRanking.ts`. See the
Zod schemas and system prompts in `src/index.ts` for the exact contract.

## Why this exists as a separate service

A React Native app bundle can't hold a secret safely — there's no equivalent of Google's
package-name + SHA1 key restriction for an Anthropic key, so it can't be embedded client-side
the way the app's existing AT/Google keys are. This Worker is the only place the Anthropic key
lives.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
# edit .dev.vars and set your own ANTHROPIC_API_KEY
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

## Deploying

```bash
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```

## Notes

- **Rate limiting is per-isolate, not distributed** — a `Map` keyed by IP, reset on cold start.
  Good enough to stop casual abuse of a personal project's API budget, not a hard guarantee
  under load. A production version would move the counter to a Durable Object or KV.
- **The model only ever extracts intent.** `/parse-nearby`'s fields are structured output via
  Zod (`betaZodOutputFormat`) — the schema and system prompt are written so the model can't
  return a specific place, distance, duration, or computed date, even if asked to; `/explain-results`
  is handed the app's own already-computed real results and can only describe them.
