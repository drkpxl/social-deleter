import { resolve } from 'node:path';
import { defineWebExtConfig } from 'wxt';

// Local dev only (gitignored): launch Vivaldi instead of Chrome, and keep a
// persistent profile so the Bluesky login survives dev-server restarts.
export default defineWebExtConfig({
  binaries: {
    vivaldi: '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
  },
  chromiumProfile: resolve('.wxt/vivaldi-profile'),
  keepProfileChanges: true,
});
