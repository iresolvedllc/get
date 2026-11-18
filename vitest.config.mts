import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // Tests run without the Upstash Redis bindings: the sliding-window
      // limiter is live state shared across runs, which would make the suite
      // flaky. The rate-limit middleware is covered by test/ratelimit.spec.ts
      // with fakes; the wired-up path is exercised manually via `wrangler dev`.
      miniflare: {
        bindings: {
          UPSTASH_REDIS_REST_URL: '',
          UPSTASH_REDIS_REST_TOKEN: '',
        },
      },
    }),
  ],
})
