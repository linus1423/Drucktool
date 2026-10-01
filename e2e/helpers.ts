import AxeBuilder from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'
import postgres from 'postgres'

export const db = postgres(process.env.DATABASE_URL ?? 'postgres://drucktool:drucktool@localhost:5432/drucktool', {
  max: 1,
  onnotice: () => {},
})

export const ADMIN = {
  email: process.env.SUPERADMIN_EMAIL ?? 'admin@example.com',
  password: process.env.SUPERADMIN_PASSWORD ?? 'bitte-aendern-123',
}

/** WCAG 2.1 AA ohne schwere oder kritische Befunde (Akzeptanzkriterium Issue #20). */
export async function expectAccessible(page: Page, name: string) {
  await page.waitForLoadState('networkidle')
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  const serious = result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  expect(serious, `Barrierefreiheit auf ${name}`).toEqual([])
}

/** Nichts darf quer über den Bildschirmrand hinausragen. */
export async function expectNoHorizontalScroll(page: Page, name: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow, `waagerechtes Scrollen auf ${name}`).toBeLessThanOrEqual(0)
}

export async function check(page: Page, name: string) {
  await expectAccessible(page, name)
  await expectNoHorizontalScroll(page, name)
}

export async function loginAsAdmin(page: Page) {
  await page.goto('/login')
  await page.waitForLoadState('networkidle')
  await page.getByText('Mit Passwort anmelden').click()
  await page.locator('#email').fill(ADMIN.email)
  await page.locator('#password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click()
  await page.waitForURL('**/uebersicht')
}

/** Kunde mit vollständigem Profil, Anmeldung per Link aus dem Mail-Ausgang. */
export async function createCustomer(tag: string) {
  const email = `e2e-${tag}-${Date.now()}@example.com`
  const billing = {
    firstName: 'Erika',
    lastName: 'Muster',
    organisation: 'Lehrstuhl für Drucktechnik',
    street: 'Boltzmannstraße 15',
    zip: '85748',
    city: 'Garching',
    country: '',
  }
  await db`insert into users (email, first_name, last_name, role, status, billing_address)
    values (${email}, 'Erika', 'Muster', 'customer', 'active', ${db.json(billing)})`
  return email
}

export async function loginAsCustomer(page: Page, email: string) {
  await page.goto('/login')
  await page.waitForLoadState('networkidle')
  await page.locator('#link-email').fill(email)
  await page.getByRole('button', { name: 'Anmeldelink senden' }).click()
  await page.getByText(`Anmeldelink an ${email}`).waitFor()
  const [mail] = await db<{ text: string }[]>`select text from email_outbox where "to" = ${email}
    order by created_at desc limit 1`
  const link = mail!.text.match(/https?:\/\/\S+\/anmelden\?token=\S+/)![0]
  await page.goto(new URL(link).pathname + new URL(link).search)
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: 'Jetzt anmelden' }).click()
  await page.waitForURL(/\/(uebersicht|auftraege|profil)/)
}
