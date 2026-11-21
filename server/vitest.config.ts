import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Git in tests never reads the developer's git config (test-git-env.ts).
    setupFiles: ['./src/test-git-env.ts'],
  },
});
