// --- A Location Fix That Can't Hang ---
// expo-location's one-shot "where am I" request has no time limit: on a phone that can't find itself quickly (indoors,
// weak signal) it simply never answers, so a "Current Location" tap sat there doing nothing, with nothing on screen.
// This asks in order of speed — a fix from the last few seconds (the phone almost always has one while the map is
// following you), then a fresh one with a time limit, then the newest older fix — and gives up cleanly (null) rather than
// waiting for ever. Pure and Expo-free so it runs under `node --test`.
export interface FixSources<T> {
  // A fix young enough to count as "where I am now", or null.
  recent: () => Promise<T | null>;
  // A fresh fix. May never answer, which is why it has a time limit.
  fresh: () => Promise<T>;
  // The best older fix worth settling for, or null.
  old: () => Promise<T | null>;
}

// Resolves with the promise's value, or null if it hasn't answered within `ms`. A rejection still rejects.
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function findFix<T>(sources: FixSources<T>, freshTimeoutMs: number): Promise<T | null> {
  const recent = await sources.recent().catch(() => null);
  if (recent) return recent;
  const fresh = await withTimeout(sources.fresh(), freshTimeoutMs).catch(() => null);
  if (fresh) return fresh;
  return sources.old().catch(() => null);
}
