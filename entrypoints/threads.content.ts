import { createDomPrimitives } from '@/src/dom-primitives';
import { serveRpc } from '@/src/rpc';

export default defineContentScript({
  matches: [
    'https://www.threads.com/*',
    'https://threads.com/*',
    // threads.net is the legacy domain and still redirects/serves.
    'https://www.threads.net/*',
    'https://threads.net/*',
  ],
  main() {
    serveRpc(createDomPrimitives());
  },
});
