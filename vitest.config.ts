import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { fileParallelism: false, env: { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://bot:bot@localhost:5432/bot_test' } },
});
