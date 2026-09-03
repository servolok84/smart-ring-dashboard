/// <reference types="vite-plugin-pwa/client" />

/**
 * Service worker registration with a visible update prompt.
 *
 * The default autoUpdate behaviour only notices a new build when the browser
 * happens to re-check sw.js on navigation, which in practice meant the app
 * kept serving a stale bundle for a long time after a deploy — several
 * reloads would still show the old version.
 *
 * So: check for updates on an interval, and when one is ready tell the user
 * rather than reloading under them. An unannounced reload mid-sync would drop
 * a live Bluetooth connection.
 */

import { registerSW } from "virtual:pwa-register";

const UPDATE_CHECK_MS = 60_000;

export function setupServiceWorker(onUpdateReady: () => void): (reload?: boolean) => void {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      onUpdateReady();
    },
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      setInterval(() => {
        registration.update().catch(() => {
          // offline, or the check raced a navigation — try again next tick
        });
      }, UPDATE_CHECK_MS);
    },
  });
  return updateSW;
}
