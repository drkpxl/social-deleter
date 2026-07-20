import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    name: 'Social Deleter',
    permissions: ['sidePanel', 'storage', 'tabs', 'scripting'],
    host_permissions: [
      'https://bsky.app/*',
      'https://www.threads.com/*',
      'https://threads.com/*',
      'https://www.threads.net/*',
      'https://threads.net/*',
      // Local LLM endpoints (Ollama / LM Studio)
      'http://localhost:11434/*',
      'http://localhost:1234/*',
      'http://127.0.0.1:11434/*',
      'http://127.0.0.1:1234/*',
    ],
  },
});
