// Kernabläufe auf 375 px Breite mit axe-Prüfung (Issue #20): Auftrag anlegen, Änderung annehmen,
// Nachricht schreiben. Dazu die wichtigsten Seiten für Mitarbeiter.
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'
import { check, createCustomer, db, loginAsAdmin, loginAsCustomer } from './helpers'

test.describe.configure({ mode: 'serial' })

let customer = ''
let requestPath = ''

test.beforeAll(async () => {
  customer = await createCustomer('kern')
})

test('Anmeldeseiten sind barrierefrei', async ({ page }) => {
  await page.goto('/login')
  await check(page, 'Anmeldung')
  await page.goto('/registrieren')
  await check(page, 'Registrierung')
})

test('Kunde legt einen Auftrag an', async ({ page }) => {
  const doc = await PDFDocument.create()
  for (let i = 0; i < 12; i++) doc.addPage([595.28, 841.89])
  const pdf = join(tmpdir(), `e2e-${Date.now()}.pdf`)
  writeFileSync(pdf, await doc.save())

  await loginAsCustomer(page, customer)
  await check(page, 'Übersicht (Kunde)')
  await page.goto('/auftraege/neu')
  await check(page, 'Neuer Auftrag')
  await page.setInputFiles('input[type=file][aria-label="Druckdatei"]', pdf)
  await page.getByText('12 Seiten').first().waitFor()
  const next = () => page.getByRole('button', { name: 'Weiter' }).click()
  await next()
  const a4 = page.getByRole('radio', { name: 'A4', exact: true })
  if ((await a4.getAttribute('aria-checked')) !== 'true') await a4.click()
  await check(page, 'Wizard Format')
  await next()
  await page.getByRole('radio', { name: 'Leimbindung', exact: true }).click()
  await page.getByRole('radio', { name: 'Doppelseitig' }).click()
  await check(page, 'Wizard Bindung')
  await next()
  await page.getByRole('radio', { name: 'Standardpapier 80 g/m²' }).click()
  await next()
  await page.locator('#copies').fill('20')
  await page.locator('#notes').fill('Bitte gut verpacken.')
  await check(page, 'Wizard Optionen')
  // Neu laden verliert nichts: der Entwurf kommt aus dem Browser zurück, samt Datei (Issue #175).
  await expect
    .poll(() => page.evaluate(() => Object.values(localStorage).some((v) => v.includes('Bitte gut verpacken.'))))
    .toBe(true)
  await page.reload()
  await expect(page.getByText('Entwurf wiederhergestellt.')).toBeVisible()
  await expect(page.locator('#copies')).toHaveValue('20')
  await expect(page.locator('#notes')).toHaveValue('Bitte gut verpacken.')
  await check(page, 'Wizard Entwurf wiederhergestellt')
  await next()
  await page.getByRole('radio', { name: /Abholung/ }).click()
  await next()
  await page.getByText('Ich habe die Auftragsbedingungen gelesen').click()
  await check(page, 'Wizard Absenden')
  await page.getByRole('button', { name: 'Auftrag verbindlich absenden' }).click()
  await page.waitForURL(/\/auftraege\/[0-9a-f-]{36}$/)
  requestPath = new URL(page.url()).pathname
  await check(page, 'Auftrag (Kunde)')
  // Nach dem Absenden ist der Entwurf weg.
  await page.goto('/auftraege/neu')
  await expect(page.getByRole('heading', { name: 'Druckdatei hochladen' })).toBeVisible()
  await expect(page.getByText('Entwurf wiederhergestellt.')).toHaveCount(0)
})

test('Kunde schreibt eine Nachricht', async ({ page }) => {
  await loginAsCustomer(page, customer)
  await page.goto(requestPath)
  await page.getByRole('textbox', { name: 'Nachricht' }).fill('Bitte mit Deckblatt in Blau.')
  await page.getByRole('button', { name: 'Senden', exact: true }).click()
  await expect(page.getByText('Bitte mit Deckblatt in Blau.')).toBeVisible()
  await check(page, 'Auftrag mit Nachricht')
})

test('Mitarbeiter schlägt eine Änderung vor', async ({ page }) => {
  await loginAsAdmin(page)
  await check(page, 'Übersicht (Mitarbeiter)')
  await page.getByRole('button', { name: 'Menü' }).click()
  await expect(page.getByRole('button', { name: 'Menü schließen' })).toHaveAttribute('aria-expanded', 'true')
  await page.locator('#hauptmenue').getByRole('link', { name: 'Aufträge' }).click()
  await page.waitForURL('**/auftraege**')
  await check(page, 'Auftragsliste')
  await page.goto(requestPath)
  await check(page, 'Auftrag (Mitarbeiter)')
  await page.getByRole('button', { name: 'Auftrag ändern' }).click()
  await page.locator('#proposal-copies').fill('30')
  await page.locator('#proposal-reason').fill('Laut Telefonat 30 statt 20 Exemplare.')
  await check(page, 'Änderungsvorschlag')
  await page.getByRole('button', { name: 'Vorschlag an den Kunden senden' }).click()
  await page.getByText('Wartet auf die Zustimmung des Kunden.').waitFor()
  // Antwortet der Kunde per Mail, trägt die Druckerei sie hier ein (Issue #113).
  await expect(page.getByRole('button', { name: 'Zustimmung eintragen' })).toBeDisabled()
  await check(page, 'Vorschlag (Mitarbeiter)')
})

test('Kunde nimmt die Änderung an', async ({ page }) => {
  await loginAsCustomer(page, customer)
  await page.goto(requestPath)
  await page.getByText('Laut Telefonat 30 statt 20 Exemplare.').waitFor()
  await check(page, 'Vorschlag (Kunde)')
  await page.getByRole('button', { name: 'Änderung annehmen' }).click()
  await page.getByText('hat der Änderung zugestimmt').waitFor()
  await check(page, 'Auftrag nach Zustimmung')
})

test('Verwaltungsseiten sind barrierefrei', async ({ page }) => {
  // Zehn Seiten mit axe-Prüfung brauchen länger als die üblichen 30 Sekunden.
  test.slow()
  await loginAsAdmin(page)
  for (const path of [
    '/profil',
    '/konto',
    '/auftraege/board',
    '/organisationsanfragen',
    '/admin/freigaben',
    '/admin/benutzer',
    '/admin/organisationen',
    '/admin/katalog',
    '/admin/emails',
    '/admin/protokoll',
  ]) {
    await page.goto(path)
    await check(page, path)
  }
})

test('Admin stellt Erinnerungen an Kunden ein (Issue #174)', async ({ page }) => {
  await loginAsAdmin(page)
  await page.goto('/admin/katalog?tab=preise')
  const field = page.getByLabel('Tage bis zur Erinnerung an eine Rückfrage')
  await expect(field).toHaveValue('')
  await field.fill('7')
  const card = page.locator('section', { has: page.getByRole('heading', { name: 'Fristen und Erinnerungen' }) })
  await card.getByRole('button', { name: 'Speichern' }).click()
  await expect(card.getByRole('button', { name: 'Speichern' })).toBeDisabled()
  const [row] = await db<{ value: { remindOnHoldDays: number } }[]>`select value from settings where key = 'deadlines'`
  expect(row!.value.remindOnHoldDays).toBe(7)
  await check(page, 'Fristen und Erinnerungen')
  // Leer schaltet die Erinnerung wieder ab.
  await field.fill('')
  await card.getByRole('button', { name: 'Speichern' }).click()
  await expect(card.getByRole('button', { name: 'Speichern' })).toBeDisabled()
  await expect(field).toHaveValue('')
})

test('Navigation passt für den Superadmin auf Tablet und Desktop in eine Zeile', async ({ page }) => {
  await loginAsAdmin(page)
  for (const width of [1024, 1280]) {
    await page.setViewportSize({ width, height: 800 })
    const nav = page.getByRole('navigation', { name: 'Hauptnavigation' })
    const height = await nav.evaluate((el) => el.getBoundingClientRect().height)
    expect(height, `Höhe der Navigation bei ${width} px`).toBeLessThan(50)
  }
  await page.getByRole('button', { name: 'Verwaltung' }).click()
  await check(page, 'Verwaltungsmenü')
  await page.locator('#verwaltungsmenue').getByRole('link', { name: 'Benutzer' }).click()
  await page.waitForURL('**/admin/benutzer')
  await expect(page.locator('#verwaltungsmenue')).toHaveCount(0)
})
