// E2E-Tests mit Barrierefreiheitsprüfung (Issue #20). Erwartet eine migrierte Datenbank mit Superadmin
// (SUPERADMIN_EMAIL/SUPERADMIN_PASSWORD) und startet den gebauten Server, falls E2E_BASE_URL nicht gesetzt ist.
import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.E2E_PORT ?? 3100)
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${port}`

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'mobil', use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 800 } } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'node .output/server/index.mjs',
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        env: { PORT: String(port), APP_URL: baseURL, COOKIE_SECURE: 'false', NODE_ENV: 'production' },
      },
})
