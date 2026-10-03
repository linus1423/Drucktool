// Angebot durch Mitarbeiter (Issue #165): Ein Mitarbeiter legt den Auftrag für einen neuen Kunden an, der Kunde
// hinterlegt seine Rechnungsadresse und nimmt das Angebot an. Auf 375 px Breite mit axe-Prüfung.
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'
import { check, db, loginAsAdmin, loginAsCustomer } from './helpers'

test.describe.configure({ mode: 'serial' })

const customer = `e2e-angebot-${Date.now()}@example.com`
let requestPath = ''

test('Mitarbeiter erstellt ein Angebot für einen neuen Kunden', async ({ page }) => {
  const doc = await PDFDocument.create()
  for (let i = 0; i < 4; i++) doc.addPage([595.28, 841.89])
  const pdf = join(tmpdir(), `e2e-angebot-${Date.now()}.pdf`)
  writeFileSync(pdf, await doc.save())

  await loginAsAdmin(page)
  await page.goto('/auftraege')
  await page.getByRole('link', { name: 'Angebot für Kunden' }).click()
  await page.waitForURL('**/auftraege/neu?angebot=true')
  await expect(page.getByRole('heading', { name: 'Neues Angebot' })).toBeVisible()
  await page.setInputFiles('input[type=file][aria-label="Druckdatei"]', pdf)
  await page.getByText('4 Seiten').first().waitFor()
  const next = () => page.getByRole('button', { name: 'Weiter' }).click()
  await next()
  const a4 = page.getByRole('radio', { name: 'A4', exact: true })
  if ((await a4.getAttribute('aria-checked')) !== 'true') await a4.click()
  await next()
  await page.getByRole('radio', { name: 'Lose', exact: true }).click()
  await next()
  await page.getByRole('radio', { name: 'Standardpapier 80 g/m²' }).click()
  await next()
  await page.locator('#title').fill('Plakate Sommerfest')
  await next()
  await page.getByRole('radio', { name: /Abholung/ }).click()
  await next()
  await page.locator('#customerEmail').fill(customer)
  await page.locator('#customerFirstName').fill('Erika')
  await page.locator('#customerLastName').fill('Muster')
  await check(page, 'Wizard Angebot')
  await page.getByRole('button', { name: 'Angebot an den Kunden senden' }).click()
  await page.waitForURL(/\/auftraege\/[0-9a-f-]{36}$/)
  requestPath = new URL(page.url()).pathname
  await page.getByText('hat das Angebot erstellt und dafür ein Kundenkonto angelegt').waitFor()
  await check(page, 'Angebot (Mitarbeiter)')
})

test('Kunde hinterlegt die Rechnungsadresse und nimmt das Angebot an', async ({ page }) => {
  await loginAsCustomer(page, customer)
  await page.goto(requestPath)
  await page.getByText('Bitte hinterlegen Sie vor der Annahme eine Rechnungsadresse').waitFor()
  await check(page, 'Angebot ohne Rechnungsadresse')

  const billing = {
    firstName: 'Erika',
    lastName: 'Muster',
    organisation: '',
    street: 'Boltzmannstraße 15',
    zip: '85748',
    city: 'Garching',
    country: '',
  }
  await db`update users set billing_address = ${db.json(billing)} where email = ${customer}`
  await page.reload()
  await page.getByText('Boltzmannstraße 15').waitFor()
  await page.getByText('Ich habe die Auftragsbedingungen gelesen').click()
  await check(page, 'Angebot (Kunde)')
  await page.getByRole('button', { name: 'Angebot verbindlich annehmen' }).click()
  await page.getByText('hat das Angebot angenommen').waitFor()
  await expect(page.getByText('Bestätigt').first()).toBeVisible()
  await check(page, 'Angebot angenommen')
})
