import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: 'core', include: ['test/*.test.ts', 'test/*.test.mjs'] },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            // Tests use the in-memory git host (REPO_HOST=fake), never real Artifacts.
            remoteBindings: false,
            miniflare: {
              bindings: {
                ADMIN_TOKEN: 'test-admin',
                AGENT_KEY: 'test-agent',
                LEASE_MS: '120000',
                HEDGE_MS: '300000',
                REPO_HOST: 'fake',
              },
            },
          }),
        ],
        test: { name: 'worker', include: ['test/worker/*.test.ts'] },
      },
    ],
  },
});
