// Meldet sich mit dem Superadmin an und prüft, dass die Übersicht erscheint.
// Läuft im Playwright-Container, siehe smoke-test.sh.
import { chromium } from 'playwright'

const baseUrl = process.env.APP_URL
const email = process.env.SUPERADMIN_EMAIL
const password = process.env.SUPERADMIN_PASSWORD

const browser = await chromium.launch()
const page = await browser.newPage()
const fehler = []
page.on('pageerror', (e) => fehler.push(e.message))

try {
  await page.goto(`${baseUrl}/login`)
  await page.getByText('Mit Passwort anmelden').click()
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click()
  await page.waitForURL('**/uebersicht**', { timeout: 15_000 })
  await page.getByRole('button', { name: 'Abmelden' }).first().waitFor({ timeout: 10_000 })
  if (fehler.length > 0) throw new Error(`JavaScript-Fehler im Browser: ${fehler.join('; ')}`)
  console.log(`Anmeldung als ${email} erfolgreich: ${page.url()}`)
} catch (e) {
  console.error('Anmeldung fehlgeschlagen:', e instanceof Error ? e.message : e)
  console.error((await page.content()).slice(0, 3000))
  process.exitCode = 1
} finally {
  await browser.close()
}
