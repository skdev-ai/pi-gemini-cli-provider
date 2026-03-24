import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/dist/**', '**/node_modules/**'],
    pool: 'forks',
    singleFork: true,
  },
});
