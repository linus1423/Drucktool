import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { parseClamdReply, scanFile, VirusFoundError, VirusScanUnavailableError } from '~/server/files/virus-scan.server'

// Nur der Marker aus der EICAR-Testdatei, nicht die ganze Datei, damit Virenscanner das Repository nicht anmeckern.
const EICAR = 'Testinhalt mit EICAR-STANDARD-ANTIVIRUS-TEST-FILE'

/** Minimaler clamd: versteht zINSTREAM und meldet Dateien mit EICAR-Marker als infiziert. */
async function fakeClamd(opts: { limit?: number } = {}) {
  const received: number[] = []
  const commands: string[] = []
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0)
    let content = Buffer.alloc(0)
    let started = false
    let done = false
    socket.on('error', () => {})
    socket.on('data', (chunk: Buffer) => {
      if (done) return
      buffer = Buffer.concat([buffer, chunk])
      if (!started) {
        const end = buffer.indexOf(0)
        if (end < 0) return
        commands.push(buffer.subarray(0, end).toString())
        buffer = buffer.subarray(end + 1)
        started = true
      }
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0)
        if (size === 0) {
          done = true
          received.push(content.length)
          const infected = content.toString('latin1').includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')
          socket.end(infected ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0')
          return
        }
        if (buffer.length < 4 + size) return
        content = Buffer.concat([content, buffer.subarray(4, 4 + size)])
        buffer = buffer.subarray(4 + size)
        if (opts.limit && content.length > opts.limit) {
          done = true
          socket.end('INSTREAM size limit exceeded. ERROR\0')
          return
        }
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return { port, received, commands, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

const dir = await mkdtemp(path.join(tmpdir(), 'drucktool-viren-'))

afterEach(() => {
  vi.unstubAllEnvs()
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('Virenprüfung mit ClamAV (Issue #99)', () => {
  it('liest die Antworten von clamd', () => {
    expect(parseClamdReply('stream: OK\0')).toEqual({ status: 'clean' })
    expect(parseClamdReply('stream: Win.Test.EICAR_HDB-1 FOUND\0')).toEqual({
      status: 'infected',
      signature: 'Win.Test.EICAR_HDB-1',
    })
    expect(() => parseClamdReply('INSTREAM size limit exceeded. ERROR\0')).toThrow(VirusScanUnavailableError)
  })

  it('prüft nichts, solange CLAMAV_HOST nicht gesetzt ist', async () => {
    vi.stubEnv('CLAMAV_HOST', '')
    await expect(scanFile('/gibt/es/nicht')).resolves.toEqual({ status: 'skipped' })
  })

  it('schickt die ganze Datei in Stücken und erkennt saubere und infizierte Dateien', async () => {
    const clamd = await fakeClamd()
    vi.stubEnv('CLAMAV_HOST', '127.0.0.1')
    vi.stubEnv('CLAMAV_PORT', String(clamd.port))
    const big = path.join(dir, 'gross.pdf')
    await writeFile(big, Buffer.alloc(300 * 1024, 1))
    const bad = path.join(dir, 'eicar.pdf')
    await writeFile(bad, EICAR)
    await expect(scanFile(big)).resolves.toEqual({ status: 'clean' })
    await expect(scanFile(bad)).resolves.toEqual({ status: 'infected', signature: 'Eicar-Test-Signature' })
    expect(clamd.commands).toEqual(['zINSTREAM', 'zINSTREAM'])
    expect(clamd.received).toEqual([300 * 1024, EICAR.length])
    await clamd.close()
  })

  it('lehnt ab, wenn clamd nicht erreichbar ist oder die Datei zu groß für clamd ist', async () => {
    const file = path.join(dir, 'datei.pdf')
    await writeFile(file, Buffer.alloc(200 * 1024, 2))
    const clamd = await fakeClamd({ limit: 100 * 1024 })
    vi.stubEnv('CLAMAV_HOST', '127.0.0.1')
    vi.stubEnv('CLAMAV_PORT', String(clamd.port))
    const tooBig = await scanFile(file).catch((e: unknown) => e)
    expect(tooBig).toBeInstanceOf(VirusScanUnavailableError)
    expect((tooBig as VirusScanUnavailableError).reason).toMatch(/size limit exceeded|StreamMaxLength/)
    await clamd.close()
    // Der Port ist jetzt frei, niemand nimmt die Verbindung an.
    await expect(scanFile(file)).rejects.toBeInstanceOf(VirusScanUnavailableError)
  })
})

const url = process.env.TEST_DATABASE_URL

describe.skipIf(!url)('Uploads mit Virenprüfung', async () => {
  process.env.DATABASE_URL = url
  const uploads = path.join(dir, 'uploads')
  process.env.UPLOAD_DIR = uploads
  const { getDb, schema } = await import('~/server/db/client.server')
  const { createUpload } = await import('~/server/files/files.server')
  const tag = `viren-${Date.now()}`
  let user: { id: string; role: 'customer' }
  let clamd: Awaited<ReturnType<typeof fakeClamd>>

  const upload = (content: string) =>
    createUpload(user, {
      role: 'main',
      filename: 'flyer.pdf',
      mimeType: 'application/pdf',
      body: Readable.from(Buffer.from(content)),
    })

  beforeAll(async () => {
    const [row] = await getDb()
      .insert(schema.users)
      .values({ email: `${tag}@test`, lastName: 'Viren', role: 'customer', status: 'active' })
      .returning()
    user = { id: row!.id, role: 'customer' }
    clamd = await fakeClamd()
  })

  afterAll(async () => {
    await clamd.close()
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  it('nimmt saubere Dateien an und weist infizierte ab, ohne sie zu speichern', async () => {
    vi.stubEnv('CLAMAV_HOST', '127.0.0.1')
    vi.stubEnv('CLAMAV_PORT', String(clamd.port))
    const ok = await upload('%PDF-1.4 sauber')
    expect(ok.filename).toBe('flyer.pdf')

    const before = await countStored()
    await expect(upload(EICAR)).rejects.toBeInstanceOf(VirusFoundError)
    expect(await countStored()).toBe(before)
    const rows = await getDb().select().from(schema.requestFiles).where(eq(schema.requestFiles.ownerId, user.id))
    expect(rows).toHaveLength(1)

    const [entry] = await getDb()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'file.virus_found'), eq(schema.auditLog.actorId, user.id)))
    expect(entry?.data).toEqual({ filename: 'flyer.pdf', signature: 'Eicar-Test-Signature' })
  })

  it('weist Uploads ab, solange der Virenscanner nicht erreichbar ist', async () => {
    vi.stubEnv('CLAMAV_HOST', '127.0.0.1')
    vi.stubEnv('CLAMAV_PORT', '1')
    const before = await countStored()
    await expect(upload('%PDF-1.4 egal')).rejects.toBeInstanceOf(VirusScanUnavailableError)
    expect(await countStored()).toBe(before)
  })

  async function countStored() {
    const files = await readdir(uploads, { recursive: true, withFileTypes: true }).catch(() => [])
    return files.filter((f) => f.isFile()).length
  }
})
