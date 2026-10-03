import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { analysePdf } from '~/server/files/pdf.server'

describe('PDF-Auswertung in eigenem Prozess', () => {
  let dir: string
  let pdf: string

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pdf-test-'))
    const doc = await PDFDocument.create()
    doc.addPage([419.5, 595.3])
    pdf = path.join(dir, 'a5.pdf')
    await writeFile(pdf, await doc.save())
  })

  afterEach(() => {
    delete process.env.PDF_WORKER_PATH
    delete process.env.PDF_ANALYSE_TIMEOUT_SECONDS
    delete process.env.PDF_ANALYSE_MAX_MEMORY_MB
  })

  async function fakeWorker(name: string, code: string) {
    const file = path.join(dir, name)
    await writeFile(file, code)
    process.env.PDF_WORKER_PATH = file
  }

  it('liest Seitenzahl und Format', async () => {
    expect(await analysePdf(pdf, 1000)).toMatchObject({ status: 'ok', pageCount: 1, pageWidthMm: 148, pageHeightMm: 210 })
  })

  it('bricht nach dem Zeitlimit ab, ohne die App zu blockieren', async () => {
    await fakeWorker('haengt.mjs', 'setInterval(() => {}, 1000)\n')
    process.env.PDF_ANALYSE_TIMEOUT_SECONDS = '0.3'
    const start = Date.now()
    expect(await analysePdf(pdf, 1000)).toMatchObject({ status: 'unreadable', pageCount: null })
    expect(Date.now() - start).toBeLessThan(5000)
  })

  it('beendet die Auswertung, wenn sie zu viel Speicher braucht', async () => {
    await fakeWorker('speicher.mjs', 'const a = []\nfor (let i = 0; ; i++) a.push({ x: i, y: String(i) })\n')
    process.env.PDF_ANALYSE_MAX_MEMORY_MB = '32'
    expect(await analysePdf(pdf, 1000)).toMatchObject({ status: 'unreadable' })
  })

  it('wertet höchstens zwei Dateien gleichzeitig aus', async () => {
    await fakeWorker(
      'zaehlt.mjs',
      "setTimeout(() => process.send({ status: 'ok', pageCount: 1, pageWidthMm: 1, pageHeightMm: 1, mixedPageSizes: false }), 200)\n",
    )
    const start = Date.now()
    await Promise.all([1, 2, 3, 4].map(() => analysePdf(pdf, 1000)))
    // Vier Auswertungen zu je 200 ms, zwei parallel: mindestens zwei Runden.
    expect(Date.now() - start).toBeGreaterThanOrEqual(380)
  })
})
