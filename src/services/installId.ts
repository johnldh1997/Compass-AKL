// --- Install ID ---
// A random id, made once per install and sent with every request to the Find Nearby Worker, so it can
// rate-limit each install separately instead of lumping everyone on one network together (see
// server/src/limits.ts). It is not a secret and not an account: it identifies no one, it just keeps one
// install from using up everyone else's allowance — and it resets if the app's data is cleared.
//
// 128 random bits from Math.random() are plenty for that: nothing here depends on it being unguessable.
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'auckland-transit:install-id';

// What the Worker accepts (INSTALL_ID_PATTERN in server/src/limits.ts): 32 lower-case hex characters.
export function generateInstallId(): string {
  let id = '';
  for (let i = 0; i < 4; i++) {
    id += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  }
  return id;
}

let cached: string | null = null;

export async function getInstallId(): Promise<string> {
  if (cached) return cached;
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    if (stored && /^[0-9a-f]{32}$/.test(stored)) {
      cached = stored;
      return stored;
    }
  } catch {
    // Unreadable storage just means a fresh id this session — never a reason to fail a search.
  }
  cached = generateInstallId();
  AsyncStorage.setItem(STORAGE_KEY, cached).catch(() => {});
  return cached;
}
