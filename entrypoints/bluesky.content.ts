import { createDomPrimitives } from '@/src/dom-primitives';
import { serveRpc } from '@/src/rpc';

export default defineContentScript({
  matches: ['https://bsky.app/*'],
  main() {
    serveRpc(createDomPrimitives());
  },
});
