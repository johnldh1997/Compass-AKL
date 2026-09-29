# Nearby Search Query Proxy

A single-purpose Cloudflare Worker: `POST /parse-nearby` turns free text ("Japanese food within
20 minutes") into `{ category, maxMinutes, modes, confident }`. That's all it does — it never
picks a place, a route, or a travel time. Those come from real Google Places/Routes data,
computed client-side in `../src/services/nearbySearch.ts`.

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
- **The model only ever extracts intent.** `category`/`maxMinutes`/`modes` are structured
  output via Zod (`betaZodOutputFormat`) — the schema and system prompt are written so the
  model can't return a specific place, distance, or duration, even if asked to.
