import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@offsplit/engine': resolve(__dirname, '../packages/engine/src/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
