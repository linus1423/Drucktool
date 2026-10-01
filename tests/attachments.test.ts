import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { BILLING } from './fixtures'
import { placeOrder } from './order-fixture'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url
const uploads = await mkdtemp(path.join(tmpdir(), 'drucktool-anhang-'))
process.env.UPLOAD_DIR = uploads

describe.skipIf(!url)('Anhänge an Nachrichten (Issue #8)', async () => {
  const { getDb, schema } = await import('~/server/db/client.server')
  const { addComment, getRequestDetail } = await import('~/server/requests/requests.server')
  const { createUpload, fileForDownload } = await import('~/server/files/files.server')
  const { UploadTooLargeError } = await import('~/server/files/storage.server')
  type Principal = import('~/server/requests/requests.server').Principal
  let customer: Principal
  let other: Principal
  let staff: Principal
  const tag = `anhang-${Date.now()}`

  const attach = (user: Principal, filename: string, content = 'Hallo') =>
    createUpload(user, { role: 'attachment', filename, mimeType: 'text/plain', body: Readable.from(Buffer.from(content)) })

  beforeAll(async () => {
    const rows = await getDb()
      .insert(schema.users)
      .values([
        { email: `${tag}-k@test`, lastName: 'Kundin', role: 'customer', status: 'active', billingAddress: BILLING },
        { email: `${tag}-f@test`, lastName: 'Fremd', role: 'customer', status: 'active', billingAddress: BILLING },
        { email: `${tag}-s@test`, lastName: 'Staff', role: 'staff', status: 'active' },
      ])
      .returning()
    customer = { id: rows[0]!.id, role: 'customer', organisationId: null }
    other = { id: rows[1]!.id, role: 'customer', organisationId: null }
    staff = { id: rows[2]!.id, role: 'staff', organisationId: null }
  })

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
    await rm(uploads, { recursive: true, force: true })
  })

  it('hängt Dateien an eine Nachricht und nennt sie in der Mail', async () => {
    const { id } = await placeOrder(customer)
    const logo = await attach(customer, 'logo.png')
    const notes = await attach(customer, 'hinweise.txt')
    await addComment(customer, { id, body: '', internal: false, attachmentIds: [logo.id, notes.id] })
    const detail = await getRequestDetail(staff, id)
    expect(detail.comments[0]!.attachments.map((a) => a.filename)).toEqual(['logo.png', 'hinweise.txt'])
    // Die Dateiliste des Auftrags zeigt nur Druckdaten.
    expect(detail.files.every((f) => f.role !== 'attachment')).toBe(true)
    const mails = await getDb()
      .select()
      .from(schema.emailOutbox)
      .where(eq(schema.emailOutbox.to, `${tag}-s@test`))
    expect(mails.some((m) => m.text.includes('Anhänge: logo.png, hinweise.txt'))).toBe(true)
    expect(await fileForDownload(customer, logo.id)).not.toBeNull()
    expect(await fileForDownload(other, logo.id)).toBeNull()
  })

  it('zeigt Anhänge interner Notizen nie Kunden', async () => {
    const { id } = await placeOrder(customer)
    const internal = await attach(staff, 'kalkulation.csv')
    await addComment(staff, { id, body: 'intern', internal: true, attachmentIds: [internal.id] })
    expect((await getRequestDetail(customer, id)).comments).toEqual([])
    expect(await fileForDownload(customer, internal.id)).toBeNull()
    expect(await fileForDownload(staff, internal.id)).not.toBeNull()
  })

  it('nimmt nur eigene, freie Anhänge an', async () => {
    const { id } = await placeOrder(customer)
    const foreign = await attach(other, 'fremd.txt')
    await expect(addComment(customer, { id, body: 'x', internal: false, attachmentIds: [foreign.id] })).rejects.toThrow(
      'Anhang wurde nicht gefunden',
    )
    const mine = await attach(customer, 'eins.txt')
    await addComment(customer, { id, body: 'x', internal: false, attachmentIds: [mine.id] })
    await expect(addComment(customer, { id, body: 'nochmal', internal: false, attachmentIds: [mine.id] })).rejects.toThrow(
      'Anhang wurde nicht gefunden',
    )
  })

  it('begrenzt Typ und Größe', async () => {
    await expect(attach(customer, 'virus.exe')).rejects.toThrow('nicht erlaubt')
    await expect(attach(customer, 'ohne-endung')).rejects.toThrow('nicht erlaubt')
    process.env.ATTACHMENT_MAX_MB = '1'
    try {
      await expect(attach(customer, 'gross.txt', 'x'.repeat(1024 * 1024 + 10))).rejects.toBeInstanceOf(UploadTooLargeError)
    } finally {
      delete process.env.ATTACHMENT_MAX_MB
    }
  })
})
