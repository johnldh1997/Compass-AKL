// --- Update Check With A Time Limit ---
// On launch the app looks for a newer over-the-air update and, when there is one, downloads it and restarts into it, so a
// single close-and-reopen always lands on the latest version. That check used to hold the whole app on a "Checking for
// updates…" screen for as long as the network took — 10 to 25 seconds on a weak connection. Now it gets a fixed budget:
// once that's spent the app opens as it is, and whatever is still downloading finishes in the background and is used on
// the next launch. Never by a surprise restart halfway through using the app (or a journey).
// Pure and Expo-free so it runs under `node --test`.
export interface UpdateSteps {
  // Whether a newer update is available.
  check: () => Promise<boolean>;
  download: () => Promise<void>;
  // Restarts the app into the downloaded update; the current instance is gone afterwards.
  restart: () => Promise<void>;
  // Lets the loading screen say what it's doing.
  onStage?: (stage: 'downloading' | 'restarting') => void;
}

export const UPDATE_WAIT_MS = 5_000;

// Resolves when the app should open: up to date, the check failed, or the budget ran out. Never resolves when the app is
// restarting into a new update (this instance is about to be replaced, so it must not open).
export function runUpdateCheck(steps: UpdateSteps, budgetMs: number = UPDATE_WAIT_MS): Promise<void> {
  return new Promise<void>((resolve) => {
    let gaveUp = false;
    let restarting = false;
    const timer = setTimeout(() => {
      if (restarting) return;
      gaveUp = true;
      resolve();
    }, budgetMs);

    (async () => {
      try {
        if ((await steps.check()) && !gaveUp) {
          steps.onStage?.('downloading');
          await steps.download();
          if (gaveUp) return;
          restarting = true;
          steps.onStage?.('restarting');
          await steps.restart();
          return;
        }
      } catch (err) {
        console.warn('Update check failed:', err);
      }
      clearTimeout(timer);
      if (!gaveUp) resolve();
    })();
  });
}
