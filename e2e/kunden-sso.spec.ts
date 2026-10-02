// Kunden-Anmeldung über den TUM-Keycloak (Issue #60). Der Anbieter wird durch e2e/mock-idp.mjs ersetzt.
import { expect, test, type Page } from '@playwright/test'
import { check, createCustomer, db } from './helpers'
import { createStaff } from './seed'

async function loginWithTum(page: Page, email: string) {
  await page.goto('/login')
  await check(page, 'Login mit TUM-Kennung')
  await page.getByRole('link', { name: 'Anmelden mit TUM-Kennung' }).click()
  await page.getByLabel('E-Mail').fill(email)
  await page.getByRole('button', { name: 'Weiter' }).click()
}

test('Neue Kunden melden sich mit der TUM-Kennung an und landen im Profil', async ({ page }) => {
  const email = `e2e-tum-${Date.now()}@tum.de`
  await loginWithTum(page, email)
  await page.waitForURL('**/profil?neu=*')
  await expect(page.getByText('Bitte hinterlegen Sie Ihre Rechnungsadresse')).toBeVisible()
  const [row] = await db<{ role: string; status: string; first_name: string }[]>`
    select role, status, first_name from users where email = ${email}`
  expect(row).toEqual({ role: 'customer', status: 'active', first_name: 'Test' })
})

test('Bestehende Kunden werden über die E-Mail-Adresse verknüpft', async ({ page }) => {
  const email = await createCustomer('tum-bestand')
  await loginWithTum(page, email)
  // Mit Rechnungsadresse geht es direkt in die Übersicht.
  await page.waitForURL('**/uebersicht')
  const [link] = await db<{ count: number }[]>`
    select count(*)::int as count from oidc_accounts o join users u on u.id = o.user_id where u.email = ${email}`
  expect(link!.count).toBe(1)
})

test('Mitarbeiter kommen über die Kunden-Anmeldung nicht herein', async ({ page }) => {
  const staff = await createStaff('tum-ma')
  await loginWithTum(page, staff.email)
  await page.waitForURL('**/login?fehler=*')
  await expect(page.getByText('Mitarbeiter der Druckerei melden sich bitte über die Mitarbeiter-Anmeldung an')).toBeVisible()
})
