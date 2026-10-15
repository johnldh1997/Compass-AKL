import AsyncStorage from '@react-native-async-storage/async-storage';

// --- Last Crash Log ---
// When the app crashes there's nothing left on the phone to say why, so a "it crashed" report is guesswork. This keeps
// the most recent uncaught JavaScript error (what, where, when) so About can show it after the next launch. It only
// sees JavaScript errors: a crash inside the map or another native part leaves nothing here — and "nothing recorded"
// is itself the answer that points there.
const STORAGE_KEY = 'auckland-transit:lastError';
const MAX_STACK_CHARS = 1200;
// A fatal error ends the app right after the handler runs, so the write gets a moment to finish first.
const WRITE_GRACE_MS = 800;

export interface LoggedError {
  message: string;
  stack: string;
  fatal: boolean;
  at: string;
}

export function installErrorLog(): void {
  const previous = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error, isFatal) => {
    const entry: LoggedError = {
      message: String(error?.message ?? error),
      stack: String(error?.stack ?? '').slice(0, MAX_STACK_CHARS),
      fatal: !!isFatal,
      at: new Date().toISOString(),
    };
    let handedOn = false;
    const handOn = () => {
      if (handedOn) return;
      handedOn = true;
      previous(error, isFatal);
    };
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(entry)).then(handOn, handOn);
    setTimeout(handOn, WRITE_GRACE_MS);
  });
}

export async function readLastError(): Promise<LoggedError | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as LoggedError) : null;
  } catch {
    return null;
  }
}
