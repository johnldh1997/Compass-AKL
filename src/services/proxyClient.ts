// --- Worker Proxy Client ---
// Every network call that needs a secret goes through the Worker (see server/): the Find Nearby model calls
// (the Anthropic key) and the Google Places and Routes calls (the Google key). A client bundle can't hold
// either safely — anyone can unpack an app — so the keys live only there, and this is the one way the app
// reaches it. Each call carries this install's id so the Worker can rate-limit installs separately (see
// installId.ts and server/src/limits.ts).
import { getInstallId } from './installId';

export function getProxyUrl(): string {
  return process.env.EXPO_PUBLIC_NEARBY_PROXY_URL ?? '';
}

// A call that outlives this is abandoned for real — the request is aborted, not just ignored — so a
// connection that has silently stalled (common on a flaky mobile network) is dropped rather than reused
// by the next attempt. Just under the 12 s step timeout in nearbyTurn.ts, so that one never gets there first.
const PROXY_TIMEOUT_MS = 11_000;

export async function postToProxy(path: string, body: unknown, failureLabel: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  try {
    const response = await fetch(`${getProxyUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Install-Id': await getInstallId() },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error ?? `${failureLabel} error ${response.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}
