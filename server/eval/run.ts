// --- Parse Eval Harness ---
// Runs every case in cases.json through the exact prompt, schema and call the Worker uses
// (src/parse.ts) and checks the structured result field by field. This is the safety net for
// changing the prompt or the model: a "fix" for one phrasing that quietly breaks another shows up
// here as a failing case, instead of in front of a user.
//
//   npm run eval                          # all cases, the Worker's current model
//   npm run eval -- --model claude-haiku-5-5
//   npm run eval -- --filter ko-          # only cases whose id contains "ko-"
//
// Needs ANTHROPIC_API_KEY (loaded from .dev.vars by the npm script). Each case is one real API call.
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { PARSE_MODEL, PreviousIntentSchema, parseNearbyIntent, type NearbyQuery, type PreviousIntent } from '../src/parse';

// --- Case Format ---
// Only the fields listed under `expect` are checked, so a case can pin down just what it is about.
//   category: lower-case substrings, any one of which must appear (the model may answer in
//             English or Korean, so a case lists the acceptable spellings)
//   maxMinutes: an exact number, null, or { min, max } for "some number in this range"
//   referenceLocationText: null, or substrings like category
//   asksQuestion: whether a clarifying question was written
interface Expect {
  category?: string[];
  maxMinutes?: number | null | { min: number; max: number };
  modes?: string[];
  useSavedHome?: boolean;
  referenceLocationText?: string[] | null;
  targetDay?: string | null;
  hour?: number | null;
  minute?: number | null;
  confident?: boolean;
  asksQuestion?: boolean;
}
interface Case {
  id: string;
  text: string;
  previous?: PreviousIntent;
  expect: Expect;
}

function show(value: unknown): string {
  return JSON.stringify(value);
}

// Returns one message per failed check — empty means the case passed.
function check(got: NearbyQuery, expect: Expect): string[] {
  const failures: string[] = [];
  const fail = (field: string, wanted: unknown, actual: unknown) =>
    failures.push(`${field}: wanted ${show(wanted)}, got ${show(actual)}`);

  if (expect.category !== undefined) {
    const category = got.category.toLowerCase();
    if (!expect.category.some((s) => category.includes(s.toLowerCase()))) fail('category', `one of ${show(expect.category)}`, got.category);
  }
  if (expect.maxMinutes !== undefined) {
    const want = expect.maxMinutes;
    const ok =
      want === null || typeof want === 'number'
        ? got.maxMinutes === want
        : got.maxMinutes !== null && got.maxMinutes >= want.min && got.maxMinutes <= want.max;
    if (!ok) fail('maxMinutes', want, got.maxMinutes);
  }
  if (expect.modes !== undefined && show([...got.modes].sort()) !== show([...expect.modes].sort())) fail('modes', expect.modes, got.modes);
  if (expect.useSavedHome !== undefined && got.useSavedHome !== expect.useSavedHome) fail('useSavedHome', expect.useSavedHome, got.useSavedHome);
  if (expect.referenceLocationText !== undefined) {
    const want = expect.referenceLocationText;
    const place = got.referenceLocationText?.toLowerCase() ?? null;
    const ok = want === null ? place === null : place !== null && want.some((s) => place.includes(s.toLowerCase()));
    if (!ok) fail('referenceLocationText', want === null ? null : `one of ${show(want)}`, got.referenceLocationText);
  }
  for (const field of ['targetDay', 'hour', 'minute', 'confident'] as const) {
    if (expect[field] !== undefined && got[field] !== expect[field]) fail(field, expect[field], got[field]);
  }
  if (expect.asksQuestion !== undefined) {
    const asked = got.clarifyingQuestion !== null && got.clarifyingQuestion.trim() !== '';
    if (asked !== expect.asksQuestion) fail('asksQuestion', expect.asksQuestion, got.clarifyingQuestion);
  }

  // Rules the schema's own descriptions promise on every answer, whatever the case is about.
  if (got.confident && got.clarifyingQuestion !== null) failures.push('invariant: a confident result must not carry a clarifying question');
  if (!got.confident && !got.clarifyingQuestion?.trim()) failures.push('invariant: a not-confident result must carry a clarifying question');
  if (got.useSavedHome && got.referenceLocationText !== null) failures.push('invariant: useSavedHome must leave referenceLocationText null');
  if (got.modes.length === 0) failures.push('invariant: modes must not be empty');
  return failures;
}

// --- Run ---
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

interface Outcome {
  id: string;
  failures: string[];
  ms: number;
  inputTokens: number;
  outputTokens: number;
}

async function runCase(client: Anthropic, model: string, c: Case): Promise<Outcome> {
  const started = Date.now();
  try {
    const previous = c.previous ? PreviousIntentSchema.parse(c.previous) : null;
    const { parsed, usage } = await parseNearbyIntent(client, c.text, previous, model);
    return {
      id: c.id,
      failures: parsed ? check(parsed, c.expect) : ['no structured result came back'],
      ms: Date.now() - started,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
    };
  } catch (err) {
    return { id: c.id, failures: [`request failed: ${err instanceof Error ? err.message : String(err)}`], ms: Date.now() - started, inputTokens: 0, outputTokens: 0 };
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set — put it in server/.dev.vars (see .dev.vars.example).');
    process.exit(2);
  }
  const model = argValue('--model') ?? PARSE_MODEL;
  const filter = argValue('--filter');
  const cases = (JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf-8')) as Case[]).filter((c) => !filter || c.id.includes(filter));
  const client = new Anthropic();

  console.log(`Model ${model} — ${cases.length} cases\n`);
  const outcomes: Outcome[] = new Array(cases.length);
  let next = 0;
  // A small worker pool: fast enough to finish in about a minute without hammering the API.
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      while (next < cases.length) {
        const i = next++;
        outcomes[i] = await runCase(client, model, cases[i]);
      }
    })
  );

  for (const o of outcomes) {
    console.log(`${o.failures.length === 0 ? 'PASS' : 'FAIL'}  ${o.id}  (${o.ms} ms)`);
    for (const f of o.failures) console.log(`        ${f}`);
  }

  const failed = outcomes.filter((o) => o.failures.length > 0);
  const times = outcomes.map((o) => o.ms).sort((a, b) => a - b);
  const percentile = (p: number) => times[Math.min(times.length - 1, Math.floor(times.length * p))];
  const sum = (pick: (o: Outcome) => number) => outcomes.reduce((total, o) => total + pick(o), 0);
  console.log(`\n${outcomes.length - failed.length}/${outcomes.length} passed on ${model}`);
  console.log(`latency  median ${percentile(0.5)} ms · p90 ${percentile(0.9)} ms · max ${times[times.length - 1]} ms`);
  console.log(`tokens   ${sum((o) => o.inputTokens)} in · ${sum((o) => o.outputTokens)} out  (${outcomes.length} calls)`);
  // Not process.exit(): on Windows that can abort Node mid-teardown with a libuv assertion.
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main();
