// Design-Seite (Issue #186): Name, Logo, Farben und Fußzeile einstellen und überall sehen.
import { expect, test } from '@playwright/test'
import { check, db, loginAsAdmin } from './helpers'

test.describe.configure({ mode: 'serial' })

// 1×1-Pixel-PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

async function reset() {
  await db`delete from settings where key in ('design', 'design_logo', 'design_favicon')`
}

test.beforeAll(reset)
test.afterAll(reset)

test('Admin stellt Name, Farbe, Impressum und Logo ein', async ({ page }) => {
  test.slow()
  await loginAsAdmin(page)
  await page.goto('/admin/design')
  await expect(page.getByRole('heading', { name: 'Design', exact: true })).toBeVisible()
  await check(page, 'Design')

  await page.getByLabel('Name', { exact: true }).fill('E2E Druckerei')
  await page.getByLabel('Primärfarbe', { exact: true }).fill('#9d174d')
  await page.getByLabel('Impressum', { exact: true }).selectOption('text')
  await page.getByLabel('Text des Impressums').fill('# Angaben\n\nE2E Fachschaft\n\n- [Kontakt](mailto:druck@example.com)')
  await page.getByRole('button', { name: 'Link hinzufügen' }).click()
  await page.getByLabel('Bezeichnung').fill('Öffnungszeiten')
  await page.getByLabel('Adresse').fill('https://example.com/zeiten')
  await page.getByRole('button', { name: 'Speichern' }).click()
  await expect(page.getByRole('status').getByText('Gespeichert.')).toBeVisible()

  await page.getByLabel('Logo', { exact: true }).setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG })
  await expect(page.getByRole('img', { name: 'Aktuelles Logo' })).toBeVisible()

  const header = page.getByRole('banner')
  await expect(header.getByText('E2E Druckerei')).toBeVisible()
  await expect(page).toHaveTitle('Design · E2E Druckerei')
  const primary = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim())
  expect(primary).toBe('#9d174d')
  await expect(
    page.getByRole('navigation', { name: 'Rechtliches' }).getByRole('link', { name: 'Öffnungszeiten' }),
  ).toHaveAttribute('href', 'https://example.com/zeiten')
  await check(page, 'Design mit eigenen Farben')
})

test('Impressum und Name sind ohne Anmeldung sichtbar', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage()
  await page.goto('/login')
  await expect(page.getByText('E2E Druckerei')).toBeVisible()
  await page.getByRole('navigation', { name: 'Rechtliches' }).getByRole('link', { name: 'Impressum' }).click()
  await page.waitForURL('**/impressum')
  await expect(page.getByRole('heading', { name: 'Angaben' })).toBeVisible()
  await expect(page.getByText('E2E Fachschaft')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Kontakt' })).toHaveAttribute('href', 'mailto:druck@example.com')
  await check(page, 'Impressum')

  const logo = await page.request.get((await page.locator('header img').getAttribute('src'))!)
  expect(logo.headers()['content-type']).toBe('image/png')
  expect(logo.headers()['cross-origin-resource-policy']).toBe('cross-origin')

  await page.goto('/datenschutz')
  await expect(page.getByRole('heading', { name: 'Seite nicht gefunden' })).toBeVisible()
})
