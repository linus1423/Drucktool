import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    // Die Integrationstests teilen sich eine Datenbank.
    fileParallelism: false,
  },
})
