import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

// --- Is The App In The Foreground? ---
// `active` is whether the app is on screen right now; `resumedAt` is a timestamp that changes each time the app
// comes back to the foreground from the background (0 until that first happens). Maps use the first to stop
// tracking your location while the app is hidden, and the second to jump back to you when you return.
export function useAppActive(): { active: boolean; resumedAt: number } {
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [resumedAt, setResumedAt] = useState(0);
  const previous = useRef(AppState.currentState);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (previous.current !== 'active' && next === 'active') setResumedAt(Date.now());
      previous.current = next;
      setActive(next === 'active');
    });
    return () => subscription.remove();
  }, []);

  return { active, resumedAt };
}
