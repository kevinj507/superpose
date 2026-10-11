import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: 'core', include: ['test/*.test.ts'] },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              bindings: { ADMIN_TOKEN: 'test-admin', AGENT_KEY: 'test-agent', LEASE_MS: '60000', HEDGE_MS: '300000' },
            },
          }),
        ],
        test: { name: 'worker', include: ['test/worker/*.test.ts'] },
      },
    ],
  },
});
