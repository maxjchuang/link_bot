import { configDefaults,defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.mjs'],
    globals: true,
    clearMocks: true,
    maxWorkers: 4,
    testTimeout: 15_000,
    passWithNoTests: true,
    // Runtime state can contain third-party plugin test files. Keep the
    // repository suite hermetic instead of executing whatever happens to be
    // installed in a local Codex home.
    exclude: [...configDefaults.exclude, '**/.worktrees/**', '**/.link-bot/**'],
  },
});
