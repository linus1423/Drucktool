// Skripte der SVK (Issue #59): anlegen, Übersicht und Nachbestellen über den Wizard.
import { mkdir, writeFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { storagePath } from '../src/server/files/storage.server'
import { check, createCustomer, db, loginAsCustomer } from './helpers'
import { seedOrder } from './seed'

test.describe.configure({ mode: 'serial' })

const stamp = Date.now()
const svkName = `E2E SVK ${stamp}`
const scriptTitle = `E2E Analysis ${stamp}`
let svkMember = ''
let svkId = ''

test.beforeAll(async () => {
  svkMember = await createCustomer('svk')
  const [org] = await db<{ id: string }[]>`insert into organisations (name, status, is_svk)
    values (${svkName}, 'active', true) returning id`
  svkId = org!.id
  await db`insert into organisation_members (organisation_id, user_id)
    select ${svkId}, id from users where email = ${svkMember}`
})

test('SVK legt ein Skript an', async ({ page }) => {
  await loginAsCustomer(page, svkMember)
  await page.goto('/skripte')
  await page.getByRole('button', { name: 'Neues Skript' }).click()
  await page.getByLabel('Titel').fill(scriptTitle)
  await page.getByLabel('Dozent oder Lehrstuhl').fill('Prof. Muster')
  await page.getByLabel('Semester').first().fill('WS 2026/27')
  await page.getByRole('button', { name: 'Speichern' }).click()
  await expect(page.getByRole('heading', { name: scriptTitle })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Erste Bestellung' })).toBeVisible()
  await check(page, 'Skripte')
})

test('SVK bestellt ein Skript nach', async ({ page }) => {
  // Erste Bestellung per Skript, damit das Skript eine Vorlage hat.
  const path = await seedOrder(svkMember, scriptTitle, svkId)
  const requestId = path.split('/').pop()!
  await db`update requests set script_id = s.id from scripts s where requests.id = ${requestId} and s.title = ${scriptTitle}`
  await db`update scripts set template_request_id = ${requestId} where title = ${scriptTitle}`
  // Die Testdaten haben nur einen Datenbankeintrag; fürs Nachbestellen wird die Datei kopiert und muss existieren.
  const [file] = await db<{ key: string }[]>`select storage_key as key from request_files where request_id = ${requestId}`
  const target = storagePath(file!.key)
  await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true })
  await writeFile(target, '%PDF-1.4 Testdatei')

  await loginAsCustomer(page, svkMember)
  await page.goto('/skripte')
  await expect(page.getByText('0 gedruckt in 1 Auftrag')).toBeVisible()
  await page.getByRole('link', { name: 'Nachbestellen' }).click()
  await expect(page.getByText('Bestellung für das Skript')).toBeVisible()
  await expect(page.getByText(/Nachbestellung von/)).toBeVisible()
  await check(page, 'Nachbestellung eines Skripts')
})
