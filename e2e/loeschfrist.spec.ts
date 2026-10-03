// Löschfrist für Druckdateien (Issue #172): Der Auftrag bleibt, statt des Links steht ein Hinweis, und eine
// Nachbestellung verlangt einen neuen Upload.
import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { check, createCustomer, db, loginAsCustomer } from './helpers'
import { seedOrder } from './seed'

test('Auftrag nach Ablauf der Löschfrist zeigt einen Hinweis statt der Datei', async ({ page }) => {
  const customer = await createCustomer('frist')
  const path = await seedOrder(customer, `E2E Löschfrist ${Date.now()}`)
  const requestId = path.split('/').pop()!
  await db`update requests set status = 'completed', status_changed_at = now() - interval '100 days' where id = ${requestId}`
  process.env.DATABASE_URL ??= 'postgres://drucktool:drucktool@localhost:5432/drucktool'
  const { uploadDir } = await import('../src/server/files/storage.server')
  const { getDb } = await import('../src/server/db/client.server')
  const { purgeRequestFiles } = await import('../src/server/maintenance/cleanup.server')
  await mkdir(uploadDir(), { recursive: true })
  await purgeRequestFiles(getDb(), 90)

  await loginAsCustomer(page, customer)
  await page.goto(path)
  await expect(page.getByText(/Die Dateien wurden am .* nach Ablauf der Löschfrist gelöscht/)).toBeVisible()
  await expect(page.getByRole('link', { name: 'test.pdf' })).toHaveCount(0)
  await expect(page.getByText('hat die Dateien nach Ablauf der Löschfrist gelöscht')).toBeVisible()
  await check(page, 'Auftrag mit gelöschten Dateien')

  await page.getByRole('link', { name: 'Erneut bestellen' }).click()
  await expect(page.getByText(/Dateien des alten Auftrags wurden nach Ablauf der Löschfrist gelöscht/)).toBeVisible()
  await expect(page.getByText('Bitte die Druckdatei hochladen.').first()).toBeVisible()
  await check(page, 'Nachbestellung ohne Datei')
})
