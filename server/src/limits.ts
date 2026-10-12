// --- Abuse Protection ---
// The Worker spends real money (every request is a model call) and its URL ships inside the app, so
// anyone who unpacks the app can call it. Three Cloudflare Rate Limiting bindings (see wrangler.toml)
// bound what any one caller can do:
//
//  - A request that carries a well-formed X-Install-Id (the app generates one per install) is counted
//    against that install, and also against its IP at a much higher ceiling — so a household or office
//    sharing one address isn't throttled as a single caller, but one install can't hog the budget.
//  - A request without one (an old app version, a script) is counted against its IP alone, and far more
//    tightly. Leaving the header off therefore buys an attacker a worse limit, not a better one.
//
// What this does and doesn't do: the install id is not a secret and proves nothing — a script can mint
// fresh ones — so it is a fairness key, not authentication. The binding is also per Cloudflare location
// and eventually consistent, so it blunts bursts rather than metering exactly. The hard backstop on
// spend is the cap on the Anthropic key itself. Genuine app attestation (Play Integrity / App Attest)
// would close the rest, but needs a native build and is deliberately not part of this.
import { jsonResponse } from './http';

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface LimitBindings {
  INSTALL_LIMITER?: RateLimiter;
  IP_LIMITER?: RateLimiter;
  ANON_LIMITER?: RateLimiter;
}

// 32 hex characters — what src/services/installId.ts in the app generates.
export const INSTALL_ID_PATTERN = /^[0-9a-f]{32}$/;

function tooManyRequests(): Response {
  return jsonResponse({ error: 'Too many requests, try again shortly' }, 429, { 'Retry-After': '30' });
}

// Null when the request may proceed, otherwise the 429 to send. Skips any limiter that isn't bound
// (e.g. a bare local run), so development doesn't need them.
export async function checkRateLimits(request: Request, env: LimitBindings): Promise<Response | null> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const installId = request.headers.get('x-install-id');

  if (installId && INSTALL_ID_PATTERN.test(installId)) {
    const [byInstall, byIp] = await Promise.all([
      env.INSTALL_LIMITER?.limit({ key: installId }),
      env.IP_LIMITER?.limit({ key: ip }),
    ]);
    return (byInstall && !byInstall.success) || (byIp && !byIp.success) ? tooManyRequests() : null;
  }

  const anonymous = await env.ANON_LIMITER?.limit({ key: ip });
  return anonymous && !anonymous.success ? tooManyRequests() : null;
}
