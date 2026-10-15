// --- Abuse Protection ---
// The Worker spends real money (every model call, and every Google lookup made on the app's behalf) and its
// URL ships inside the app, so anyone who unpacks the app can call it. Cloudflare Rate Limiting bindings (see
// wrangler.toml) bound what any one caller can do. There are two classes of call, counted separately because
// they cost and behave differently: "model" calls (read / explain / answer — each is a Claude call) and
// "google" calls (autocomplete as you type, and the ten or so lookups behind one Find Nearby search — many per
// minute, but cheap each). For each class:
//
//  - A request that carries a well-formed X-Install-Id (the app generates one per install) is counted
//    against that install, and also against its IP at a much higher ceiling — so a household or office
//    sharing one address isn't throttled as a single caller, but one install can't hog the budget.
//  - A request without one (an old app version, a script) is counted against its IP alone, and far more
//    tightly. Leaving the header off therefore buys an attacker a worse limit, not a better one.
//
// What this does and doesn't do: the install id is not a secret and proves nothing — a script can mint
// fresh ones — so it is a fairness key, not authentication. The binding is also per Cloudflare location
// and eventually consistent, so it blunts bursts rather than metering exactly. The hard backstops on spend
// are the cap on the Anthropic key and the quotas on the Google key. Genuine app attestation (Play
// Integrity / App Attest) would close the rest, but needs a native build and is deliberately not part of this.
import { jsonResponse } from './http';

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export type CallKind = 'model' | 'google';

export interface LimitBindings {
  INSTALL_LIMITER?: RateLimiter;
  IP_LIMITER?: RateLimiter;
  ANON_LIMITER?: RateLimiter;
  GOOGLE_INSTALL_LIMITER?: RateLimiter;
  GOOGLE_IP_LIMITER?: RateLimiter;
  GOOGLE_ANON_LIMITER?: RateLimiter;
}

// Which three limiters apply to each class of call.
function limitersFor(kind: CallKind, env: LimitBindings) {
  return kind === 'google'
    ? { install: env.GOOGLE_INSTALL_LIMITER, ip: env.GOOGLE_IP_LIMITER, anon: env.GOOGLE_ANON_LIMITER }
    : { install: env.INSTALL_LIMITER, ip: env.IP_LIMITER, anon: env.ANON_LIMITER };
}

// 32 hex characters — what src/services/installId.ts in the app generates.
export const INSTALL_ID_PATTERN = /^[0-9a-f]{32}$/;

function tooManyRequests(): Response {
  return jsonResponse({ error: 'Too many requests, try again shortly' }, 429, { 'Retry-After': '30' });
}

// Null when the request may proceed, otherwise the 429 to send. Skips any limiter that isn't bound
// (e.g. a bare local run), so development doesn't need them.
export async function checkRateLimits(request: Request, env: LimitBindings, kind: CallKind = 'model'): Promise<Response | null> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const installId = request.headers.get('x-install-id');
  const limiters = limitersFor(kind, env);

  if (installId && INSTALL_ID_PATTERN.test(installId)) {
    const [byInstall, byIp] = await Promise.all([
      limiters.install?.limit({ key: installId }),
      limiters.ip?.limit({ key: ip }),
    ]);
    return (byInstall && !byInstall.success) || (byIp && !byIp.success) ? tooManyRequests() : null;
  }

  const anonymous = await limiters.anon?.limit({ key: ip });
  return anonymous && !anonymous.success ? tooManyRequests() : null;
}
