// Abläufe über mehrere Rollen (Issue #35): Erstanmeldung eines Kunden, Zugriffsschutz, Konflikt bei gleichzeitiger
// Bearbeitung und ein Auftrag von „Eingereicht“ bis „Fertig“. Aufträge entstehen per Skript (seed.ts), nicht über die
// Oberfläche; den Wizard prüft kernablaeufe.spec.ts.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { check, createCustomer, db, loginAsAdmin, loginAsCustomer, loginWithPassword, openLoginLink } from './helpers'
import { createStaff, seedOrder } from './seed'

test.describe.configure({ mode: 'serial' })

let owner = ''
let stranger = ''
let staff = { email: '', password: '' }
let requestPath = ''
const title = `E2E Ablauf ${Date.now()}`

test.beforeAll(async () => {
  owner = await createCustomer('eigentuemer')
  stranger = await createCustomer('fremd')
  staff = await createStaff('mitarbeiter')
  requestPath = await seedOrder(owner, title)
})

/** Eigene Sitzung je Person; axe braucht dafür einen eigenen Kontext statt browser.newPage(). */
async function newSession(browser: Browser) {
  return (await browser.newContext()).newPage()
}

const statusBadge = (page: Page) =>
  page
    .getByRole('main')
    .getByText(/^(Eingereicht|Bestätigt|Rückfrage|Fertig)$/)
    .first()

test('Neuer Kunde meldet sich per Link an und ergänzt sein Profil', async ({ page }) => {
  const email = `e2e-neu-${Date.now()}@example.com`
  await openLoginLink(page, email)
  await page.waitForURL('**/profil?neu=*')
  await expect(page.getByText('Bitte hinterlegen Sie Ihre Rechnungsadresse')).toBeVisible()
  await check(page, 'Profil (Erstanmeldung)')

  await page.locator('#firstName').fill('Nora')
  await page.locator('#lastName').fill('Neu')
  for (const [field, value] of [
    ['firstName', 'Nora'],
    ['lastName', 'Neu'],
    ['street', 'Arcisstraße 21'],
    ['zip', '80333'],
    ['city', 'München'],
  ]) {
    await page.locator(`#billing-${field}`).fill(value!)
  }
  await page.getByRole('button', { name: 'Profil speichern' }).click()
  await expect(page.getByText('Gespeichert')).toBeVisible()

  // Mit Rechnungsadresse fehlt der Hinweis im Wizard.
  await page.goto('/auftraege/neu')
  await expect(page.getByRole('heading', { name: 'Neuer Auftrag' })).toBeVisible()
  await expect(page.getByText('Bitte hinterlegen Sie zuerst eine Rechnungsadresse')).toHaveCount(0)
  const [row] = await db<{ role: string; status: string }[]>`select role, status from users where email = ${email}`
  expect(row).toEqual({ role: 'customer', status: 'active' })
})

test('Kunde öffnet keinen fremden Auftrag', async ({ page }) => {
  await loginAsCustomer(page, stranger)
  await page.goto(requestPath)
  await expect(page.getByText('Auftrag nicht gefunden')).toBeVisible()
  await expect(page.getByText(title)).toHaveCount(0)
  await check(page, 'Fremder Auftrag')

  await page.goto('/auftraege')
  await page.waitForLoadState('networkidle')
  await expect(page.getByText(title)).toHaveCount(0)
})

test('Verwaltung ist nur für Admins erreichbar', async ({ browser }) => {
  const customerPage = await newSession(browser)
  await loginAsCustomer(customerPage, stranger)
  const staffPage = await newSession(browser)
  await loginWithPassword(staffPage, staff)

  for (const page of [customerPage, staffPage]) {
    for (const path of ['/admin/benutzer', '/admin/katalog', '/admin/protokoll', '/admin/freigaben']) {
      await page.goto(path)
      await page.waitForURL('**/auftraege')
    }
  }
  // Kunden kommen auch nicht auf das Board der Druckerei.
  await customerPage.goto('/auftraege/board')
  await customerPage.waitForURL('**/auftraege')
  await customerPage.context().close()
  await staffPage.context().close()
})

test('Zwei Mitarbeiter ändern denselben Auftrag: Konflikt-Hinweis', async ({ browser }) => {
  const first = await newSession(browser)
  await loginAsAdmin(first)
  const second = await newSession(browser)
  await loginWithPassword(second, staff)
  await first.goto(requestPath)
  await second.goto(requestPath)
  await expect(statusBadge(second)).toHaveText('Eingereicht')

  await first.getByRole('button', { name: 'Auftrag annehmen' }).click()
  await first.getByRole('button', { name: 'Auftrag annehmen' }).click()
  await expect(statusBadge(first)).toHaveText('Bestätigt')

  // Die zweite Ansicht ist veraltet: ihre Rückfrage darf die Bestätigung nicht still überschreiben.
  await second.getByRole('button', { name: 'Rückfrage stellen' }).click()
  await second.locator('#note').fill('Welche Farbe soll das Deckblatt haben?')
  await second.getByRole('button', { name: 'Rückfrage stellen' }).click()
  await expect(second.getByText('Der Auftrag wurde zwischenzeitlich von jemand anderem geändert.')).toBeVisible()
  await check(second, 'Konflikt-Hinweis')
  await second.getByRole('button', { name: 'Neu laden' }).click()
  await expect(statusBadge(second)).toHaveText('Bestätigt')
  await first.context().close()
  await second.context().close()
})

test('Mitarbeiter schließt den Auftrag ab, der Kunde sieht „Fertig“', async ({ page, browser }) => {
  await loginWithPassword(page, staff)
  await page.goto(requestPath)
  await page.getByRole('button', { name: 'Als fertig markieren' }).click()
  await page.locator('#note').fill('Liegt im Regal zur Abholung.')
  await page.getByRole('button', { name: 'Als fertig markieren' }).click()
  await expect(statusBadge(page)).toHaveText('Fertig')
  await expect(page.getByText('Nächster Schritt')).toHaveCount(0)

  const customerPage = await newSession(browser)
  await loginAsCustomer(customerPage, owner)
  await customerPage.goto(requestPath)
  await expect(statusBadge(customerPage)).toHaveText('Fertig')
  await expect(customerPage.getByText('Liegt im Regal zur Abholung.')).toBeVisible()
  await check(customerPage, 'Fertiger Auftrag (Kunde)')
  await customerPage.context().close()

  const mails = await db<{ subject: string }[]>`select subject from email_outbox where "to" = ${owner}
    order by created_at`
  expect(mails.length).toBeGreaterThanOrEqual(2)
})
