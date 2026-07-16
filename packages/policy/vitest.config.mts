import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only run the TypeScript sources — tsc also compiles __tests__ into
    // dist/, and vitest 4 no longer excludes dist/ by default.
    include: ['src/**/*.test.ts'],
  },
});
