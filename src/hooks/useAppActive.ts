import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

// A system screen laid over the app (a permission prompt, "turn on location") pauses it for a moment, and that is not
// leaving the app. Pauses shorter than this are ignored: they neither switch `active` off nor count as coming back.
// Without this a permission prompt that closes instantly set off a loop — prompt closes, the app counts it as a return
// and asks again — about twenty times a second until the phone's view system gave out and the app crashed.
const BRIEF_PAUSE_MS = 2000;

// --- Is The App In The Foreground? ---
// `active` is whether the app is on screen right now; `resumedAt` is a timestamp that changes each time the app
// comes back to the foreground after really being away (0 until that first happens). Maps use the first to stop
// tracking your location while the app is hidden, and the second to jump back to you when you return.
export function useAppActive(): { active: boolean; resumedAt: number } {
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [resumedAt, setResumedAt] = useState(0);
  // When the app was last seen leaving the foreground; null while it's in the foreground.
  const leftAt = useRef<number | null>(AppState.currentState === 'active' ? null : Date.now());

  useEffect(() => {
    let pendingInactive: ReturnType<typeof setTimeout> | undefined;
    const subscription = AppState.addEventListener('change', (next) => {
      clearTimeout(pendingInactive);
      if (next === 'active') {
        if (leftAt.current !== null && Date.now() - leftAt.current >= BRIEF_PAUSE_MS) setResumedAt(Date.now());
        leftAt.current = null;
        setActive(true);
        return;
      }
      if (leftAt.current === null) leftAt.current = Date.now();
      pendingInactive = setTimeout(() => setActive(false), BRIEF_PAUSE_MS);
    });
    return () => {
      clearTimeout(pendingInactive);
      subscription.remove();
    };
  }, []);

  return { active, resumedAt };
}
