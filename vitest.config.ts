import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    // Die Integrationstests teilen sich eine Datenbank.
    fileParallelism: false,
    // pnpm test:coverage gibt die Abdeckung im CI-Log aus.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/routeTree.gen.ts'],
      reporter: ['text-summary', 'text'],
    },
  },
})
