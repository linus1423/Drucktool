import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { PDFDocument } from 'pdf-lib'
import { BILLING } from './fixtures'
import { orderInput } from './order-fixture'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url
const uploads = await mkdtemp(path.join(tmpdir(), 'drucktool-skripte-'))
process.env.UPLOAD_DIR = uploads

describe.skipIf(!url)('Skripte der SVK (Issue #59)', async () => {
  const { getDb, schema } = await import('~/server/db/client.server')
  const scriptsModule = await import('~/server/scripts/scripts.server')
  const { changeStatus, createRequest, getRequestDetail, listRequests, prepareReorder } =
    await import('~/server/requests/requests.server')
  const { createUpload, fileForDownload } = await import('~/server/files/files.server')
  type Principal = import('~/server/requests/requests.server').Principal

  const stamp = Date.now()
  let anna: Principal
  let ben: Principal
  let fremd: Principal
  let staff: Principal
  let svk: string
  let andere: string

  async function user(name: string, role: Principal['role']): Promise<Principal> {
    const [u] = await getDb()
      .insert(schema.users)
      .values({ email: `${name}-${stamp}@svk.test`, lastName: name, role, status: 'active', billingAddress: BILLING })
      .returning()
    return { id: u!.id, role }
  }

  beforeAll(async () => {
    await getDb().update(schema.users).set({ emailNotifications: false })
    anna = await user('anna', 'customer')
    ben = await user('ben', 'customer')
    fremd = await user('fremd', 'customer')
    staff = await user('staff', 'staff')
    const [a, b] = await getDb()
      .insert(schema.organisations)
      .values([
        { name: `SVK ${stamp}`, status: 'active', isSvk: true },
        { name: `Lehrstuhl ${stamp}`, status: 'active' },
      ])
      .returning()
    svk = a!.id
    andere = b!.id
    await getDb()
      .insert(schema.organisationMembers)
      .values([
        { organisationId: svk, userId: anna.id },
        { organisationId: svk, userId: ben.id },
        { organisationId: andere, userId: fremd.id, isAdmin: true },
      ])
  })

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
    await rm(uploads, { recursive: true, force: true })
  })

  async function pdfUpload(user: Principal) {
    const doc = await PDFDocument.create()
    for (let i = 0; i < 4; i++) doc.addPage([595.28, 841.89])
    const body = Readable.from(Buffer.from(await doc.save()))
    return createUpload(user, { role: 'main', filename: 'skript.pdf', mimeType: 'application/pdf', body })
  }

  const base = { title: `Analysis 1 ${stamp}`, lecturer: 'Prof. Muster', semester: 'WS 2026/27', stock: 0, notes: '' }

  it('lässt nur SVK-Mitglieder Skripte anlegen und sehen', async () => {
    await expect(scriptsModule.createScript(fremd, { ...base, organisationId: andere })).rejects.toThrow('Keine Berechtigung')
    await expect(scriptsModule.createScript(fremd, { ...base, organisationId: svk })).rejects.toThrow('Keine Berechtigung')
    await expect(scriptsModule.createScript(staff, { ...base, organisationId: svk })).rejects.toThrow('Keine Berechtigung')
    await expect(scriptsModule.listScripts(fremd, {})).rejects.toThrow('Keine Berechtigung')

    const { id } = await scriptsModule.createScript(anna, { ...base, organisationId: svk })
    const forBen = await scriptsModule.listScripts(ben, {})
    expect(forBen.rows.map((r) => r.id)).toContain(id)
    expect(forBen.canManage).toBe(true)
    const forStaff = await scriptsModule.listScripts(staff, { semester: 'WS 2026/27' })
    expect(forStaff.rows.map((r) => r.id)).toContain(id)
    expect(forStaff.canManage).toBe(false)
    await expect(scriptsModule.updateScript(fremd, { ...base, id, archived: false, stock: 999 })).rejects.toThrow(
      'Keine Berechtigung',
    )
  })

  it('bestellt ein Skript, Kollegen bestellen nach und der Bestand wächst mit fertigen Aufträgen', async () => {
    const { id: scriptId } = await scriptsModule.createScript(anna, {
      ...base,
      title: `Lineare Algebra ${stamp}`,
      organisationId: svk,
    })
    // Erste Bestellung: der Auftrag gehört der SVK und wird Vorlage des Skripts.
    const first = await createRequest(anna, {
      ...(await orderInput(anna, { title: 'LA' })),
      mainFileId: (await pdfUpload(anna)).id,
      scriptId,
    })
    const [stored] = await getDb().select().from(schema.requests).where(eq(schema.requests.id, first.id))
    expect(stored).toMatchObject({ organisationId: svk, scriptId })
    let [script] = await getDb().select().from(schema.scripts).where(eq(schema.scripts.id, scriptId))
    expect(script!.templateRequestId).toBe(first.id)

    // Ben sieht Annas Auftrag (nur lesend) und darf ihn über das Skript nachbestellen.
    const detail = await getRequestDetail(ben, first.id)
    expect(detail.canAct).toBe(false)
    expect((await listRequests(ben, { organisationId: svk })).rows.map((r) => r.id)).toContain(first.id)
    expect(await fileForDownload(ben, detail.files[0]!.id)).not.toBeNull()
    expect(await fileForDownload(fremd, detail.files[0]!.id)).toBeNull()
    await expect(prepareReorder(ben, first.id)).rejects.toThrow('Auftrag nicht gefunden')
    const template = await prepareReorder(ben, first.id, scriptId)
    expect(template.mainFile).not.toBeNull()
    const input = await orderInput(ben, { title: 'LA', spec: { copies: 25 } })
    const second = await createRequest(ben, {
      ...input,
      mainFileId: template.mainFile!.id,
      reorderOfId: first.id,
      scriptId,
    })
    ;[script] = await getDb().select().from(schema.scripts).where(eq(schema.scripts.id, scriptId))
    expect(script!.templateRequestId).toBe(second.id)

    // Fremde dürfen weder die Vorlage holen noch für das Skript bestellen.
    await expect(prepareReorder(fremd, first.id, scriptId)).rejects.toThrow('Keine Berechtigung')
    await expect(createRequest(fremd, { ...(await orderInput(fremd)), scriptId })).rejects.toThrow('Keine Berechtigung')

    await changeStatus(staff, { id: second.id, version: 1, to: 'confirmed' })
    let row = (await scriptsModule.listScripts(anna, {})).rows.find((r) => r.id === scriptId)!
    expect(row).toMatchObject({ stock: 0, openCopies: 10 + 25, orders: 2 })
    await changeStatus(staff, { id: second.id, version: 2, to: 'completed' })
    row = (await scriptsModule.listScripts(anna, {})).rows.find((r) => r.id === scriptId)!
    expect(row).toMatchObject({ stock: 25, openCopies: 10, printedCopies: 25 })
    expect(row.lastOrder?.id).toBe(second.id)
  })

  it('kopiert ein Skript für das nächste Semester und archiviert das alte', async () => {
    const { id } = await scriptsModule.createScript(anna, { ...base, title: `Physik ${stamp}`, organisationId: svk })
    const copy = await scriptsModule.copyScript(ben, { id, semester: 'SS 2027' })
    await scriptsModule.updateScript(anna, { ...base, title: `Physik ${stamp}`, id, archived: true })
    const current = await scriptsModule.listScripts(anna, { semester: 'SS 2027' })
    expect(current.rows.map((r) => r.id)).toEqual([copy.id])
    expect(current.semesters).toEqual(expect.arrayContaining(['SS 2027', 'WS 2026/27']))
    expect((await scriptsModule.listScripts(anna, { archived: true })).rows.map((r) => r.id)).toContain(id)
    // Archivierte Skripte bestellt niemand mehr nach.
    await expect(createRequest(anna, { ...(await orderInput(anna)), scriptId: id })).rejects.toThrow('archiviert')
  })

  it('verliert den Zugriff, wenn die Organisation keine SVK mehr ist', async () => {
    await getDb().update(schema.organisations).set({ isSvk: false }).where(eq(schema.organisations.id, svk))
    try {
      await expect(scriptsModule.listScripts(anna, {})).rejects.toThrow('Keine Berechtigung')
    } finally {
      await getDb().update(schema.organisations).set({ isSvk: true }).where(eq(schema.organisations.id, svk))
    }
  })
})
