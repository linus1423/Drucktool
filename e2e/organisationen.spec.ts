// Verwalter einer Organisation (Issue #12): Kollegen per Link einladen, ihre Aufträge sehen, Mitglieder entfernen.
import { expect, test, type Browser } from '@playwright/test'
import { check, createCustomer, db, loginAsAdmin, loginAsCustomer } from './helpers'
import { seedOrder } from './seed'

test.describe.configure({ mode: 'serial' })

const stamp = Date.now()
const orgName = `E2E Lehrstuhl ${stamp}`
const title = `E2E Lehrstuhl-Auftrag ${stamp}`
let chef = ''
let kollege = ''
let organisationId = ''
let inviteUrl = ''

test.beforeAll(async () => {
  chef = await createCustomer('verwalter')
  kollege = await createCustomer('kollege')
  await db`update users set first_name = 'Karl', last_name = 'Kollege' where email = ${kollege}`
  const [org] = await db<{ id: string }[]>`insert into organisations (name, status) values (${orgName}, 'active')
    returning id`
  organisationId = org!.id
  await db`insert into organisation_members (organisation_id, user_id, is_admin)
    select ${organisationId}, id, true from users where email = ${chef}`
})

async function newSession(browser: Browser) {
  return (await browser.newContext()).newPage()
}

test('Verwalter erstellt einen Einladungslink', async ({ page }) => {
  await loginAsCustomer(page, chef)
  await page.goto('/profil')
  await page.getByRole('link', { name: 'Verwalten' }).click()
  await expect(page.getByRole('heading', { name: orgName })).toBeVisible()
  await page.getByRole('button', { name: 'Einladungslink erstellen' }).click()
  const link = page.getByLabel('Neuer Einladungslink')
  await expect(link).toHaveValue(/\/einladung\//)
  inviteUrl = new URL(await link.inputValue()).pathname
  await expect(page.getByText('Offene Einladungen')).toBeVisible()
  await check(page, 'Organisation verwalten')
})

test('Kollege tritt über den Link bei', async ({ browser }) => {
  const page = await newSession(browser)
  await loginAsCustomer(page, kollege)
  await page.goto(inviteUrl)
  await expect(page.getByText(orgName)).toBeVisible()
  await check(page, 'Einladung')
  await page.getByRole('button', { name: 'Beitreten' }).click()
  await page.waitForURL('**/profil')
  await expect(page.getByText(orgName)).toBeVisible()
  // Der Link ist verbraucht.
  await page.goto(inviteUrl)
  await expect(page.getByText('ungültig, abgelaufen oder wurde schon verwendet')).toBeVisible()
  await page.context().close()
})

test('Verwalter sieht den Auftrag des Kollegen, ändern kann er ihn nicht', async ({ page }) => {
  const requestPath = await seedOrder(kollege, title, organisationId)
  await loginAsCustomer(page, chef)
  await page.goto('/auftraege?ansicht=alle')
  await page.getByLabel('Organisation').selectOption(organisationId)
  await expect(page.getByRole('link', { name: title })).toBeVisible()
  await expect(page.getByRole('main').getByText('Karl Kollege').first()).toBeVisible()

  await page.goto(requestPath)
  await expect(page.getByText('Sie sehen diesen Auftrag als Verwalter der Organisation.')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Nachricht' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Beobachten/ })).toHaveCount(0)
  await check(page, 'Auftrag eines Kollegen (Verwalter)')
})

test('Verwalter entfernt den Kollegen', async ({ page }) => {
  await loginAsCustomer(page, chef)
  await page.goto(`/organisationen/${organisationId}`)
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('listitem').filter({ hasText: 'Karl Kollege' }).getByRole('button', { name: 'Entfernen' }).click()
  await expect(page.getByText('Karl Kollege')).toHaveCount(0)
  const rows = await db`select 1 from organisation_members m join users u on u.id = m.user_id
    where m.organisation_id = ${organisationId} and u.email = ${kollege}`
  expect(rows).toHaveLength(0)
})

test('Fremde oder unbekannte Organisation ergibt 404 (Issue #141)', async ({ page, browser }) => {
  // Der entfernte Kollege verwaltet die Organisation nicht; sie sieht für ihn aus wie eine unbekannte.
  await loginAsCustomer(page, kollege)
  for (const id of [organisationId, '00000000-0000-4000-8000-000000000000', 'keine-id']) {
    expect((await page.goto(`/organisationen/${id}`))?.status()).toBe(404)
    await expect(page.getByText('Organisation nicht gefunden')).toBeVisible()
  }
  await check(page, 'Unbekannte Organisation')

  const admin = await newSession(browser)
  await loginAsAdmin(admin)
  for (const id of ['00000000-0000-4000-8000-000000000000', 'keine-id']) {
    expect((await admin.goto(`/admin/organisationen/${id}`))?.status()).toBe(404)
    await expect(admin.getByText('Organisation nicht gefunden')).toBeVisible()
  }
})
