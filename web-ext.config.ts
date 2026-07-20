import { resolve } from 'node:path';
import { defineWebExtConfig } from 'wxt';

/**
 * Dev-launch config. The build output is plain Chromium MV3, so the same
 * artifact runs in Chrome, Vivaldi, Brave, or Edge — only the dev launcher
 * needs to know where each binary lives.
 *
 * `keepProfileChanges` gives the dev browser a persistent profile so the
 * Bluesky login survives dev-server restarts. Chrome and Vivaldi get separate
 * profiles because a Chromium profile is not portable between builds.
 */
export default defineWebExtConfig({
  binaries: {
    chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    vivaldi: '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
    edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  },
  chromiumProfile: resolve(`.wxt/profile-${process.env.WXT_BROWSER ?? 'chrome'}`),
  keepProfileChanges: true,
});
