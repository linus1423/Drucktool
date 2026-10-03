// Organisationsanfrage mit allen Stammdaten und Vorschlag der naheliegendsten Organisation (Issue #176).
import { expect, test } from '@playwright/test'
import { check, createCustomer, db, loginAsAdmin, loginAsCustomer } from './helpers'

test.describe.configure({ mode: 'serial' })

const stamp = Date.now()
const existing = `E2E Fachschaft Maschinenbau ${stamp}`
const requested = `E2E Fachschaft Maschienbau ${stamp}`
let kunde = ''

test.beforeAll(async () => {
  kunde = await createCustomer('orgfrage')
  await db`insert into organisations (name, cost_center, status) values (${existing}, ${`KS-${stamp}`}, 'active')`
})

test('Kunde fragt eine Organisation mit allen Angaben an', async ({ page }) => {
  await loginAsCustomer(page, kunde)
  await page.goto('/profil')
  await page.getByRole('button', { name: 'Organisation anfragen' }).click()
  const form = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Organisationen' }) })
  await form.getByLabel('Name der Organisation').fill(requested)
  await form.getByLabel('Straße und Hausnummer').fill('Boltzmannstraße 15')
  await form.getByLabel('PLZ', { exact: true }).fill('85748')
  await form.getByLabel('Ort', { exact: true }).fill('Garching')
  await form.getByLabel('Kostenstelle').fill(`KS-${stamp}`)
  await check(page, 'Organisation anfragen')
  await page.getByRole('button', { name: 'Anfrage senden' }).click()
  await expect(page.getByText('Ihre Anfrage ist eingegangen')).toBeVisible()
})

test('Mitarbeiter bekommt die bestehende Organisation vorgeschlagen', async ({ page }) => {
  await loginAsAdmin(page)
  await page.goto('/organisationsanfragen')
  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: requested }) })
  await expect(card.getByText(`Vorschlag: „${existing}“`)).toBeVisible()
  await expect(card.getByLabel('Organisation', { exact: true })).toHaveValue(/.+/)
  await check(page, 'Organisationsanfragen')
  // Beim Anlegen ist das Formular mit den Angaben aus der Anfrage vorbefüllt.
  await card.getByLabel('Neue Organisation anlegen').check()
  await expect(card.getByLabel('Straße und Hausnummer')).toHaveValue('Boltzmannstraße 15')
  await expect(card.getByLabel('Ort', { exact: true })).toHaveValue('Garching')
  await page.screenshot({ path: 'test-results/organisationsanfrage.png', fullPage: true })
  await card.getByLabel('Bestehender Organisation zuordnen').check()
  await card.getByRole('button', { name: 'Zuordnen' }).click()
  await expect(page.getByRole('heading', { name: requested })).toHaveCount(0)
})
