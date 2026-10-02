// E2E-Tests mit Barrierefreiheitsprüfung (Issue #20). Erwartet eine migrierte Datenbank mit Superadmin
// (SUPERADMIN_EMAIL/SUPERADMIN_PASSWORD) und startet den gebauten Server, falls E2E_BASE_URL nicht gesetzt ist.
import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.E2E_PORT ?? 3100)
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${port}`
const idpPort = Number(process.env.MOCK_IDP_PORT ?? 3199)
const idpURL = `http://localhost:${idpPort}`

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
    : [
        // Ersetzt den TUM-Keycloak für die Kunden-Anmeldung (Issue #60).
        {
          command: 'node e2e/mock-idp.mjs',
          url: `${idpURL}/health`,
          reuseExistingServer: !process.env.CI,
          env: { MOCK_IDP_PORT: String(idpPort) },
        },
        {
          command: 'node .output/server/index.mjs',
          url: `${baseURL}/api/health`,
          reuseExistingServer: !process.env.CI,
          env: {
            PORT: String(port),
            APP_URL: baseURL,
            COOKIE_SECURE: 'false',
            NODE_ENV: 'production',
            CUSTOMER_OIDC_ISSUER: idpURL,
            CUSTOMER_OIDC_CLIENT_ID: 'drucktool-e2e',
            CUSTOMER_OIDC_CLIENT_SECRET: 'e2e-geheim',
            CUSTOMER_OIDC_DISPLAY_NAME: 'TUM-Kennung',
          },
        },
      ],
})
