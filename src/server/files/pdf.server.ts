// Liest Seitenzahl und Seitengröße aus einer PDF. Scheitert das, wird die Datei
// trotzdem angenommen (Lastenheft 8) und nur markiert.
import { open, readFile } from 'node:fs/promises'
import { PDFDocument } from 'pdf-lib'

export type PdfInfo = {
  status: 'ok' | 'encrypted' | 'unreadable' | 'not_pdf'
  pageCount: number | null
  pageWidthMm: number | null
  pageHeightMm: number | null
  mixedPageSizes: boolean
}

/** Größere Dateien werden nicht im Speicher geparst; der Kunde gibt die Seitenzahl dann selbst an. */
const ANALYSE_MAX_BYTES = 150 * 1024 * 1024
const PT_TO_MM = 25.4 / 72

async function hasPdfHeader(file: string) {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(1024)
    const { bytesRead } = await handle.read(buffer, 0, 1024, 0)
    return buffer.subarray(0, bytesRead).includes('%PDF-')
  } finally {
    await handle.close()
  }
}

const empty = (status: PdfInfo['status']): PdfInfo => ({
  status,
  pageCount: null,
  pageWidthMm: null,
  pageHeightMm: null,
  mixedPageSizes: false,
})

export async function analysePdf(file: string, sizeBytes: number): Promise<PdfInfo> {
  if (!(await hasPdfHeader(file))) return empty('not_pdf')
  if (sizeBytes > ANALYSE_MAX_BYTES) return empty('unreadable')
  try {
    const doc = await PDFDocument.load(await readFile(file), {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
    })
    const pages = doc.getPages()
    if (pages.length === 0) return empty('unreadable')
    const sizes = pages.map((page) => {
      const { width, height } = page.getSize()
      const rotated = page.getRotation().angle % 180 !== 0
      const w = Math.round((rotated ? height : width) * PT_TO_MM)
      const h = Math.round((rotated ? width : height) * PT_TO_MM)
      return [w, h] as const
    })
    const [w, h] = sizes[0]!
    const mixed = sizes.some(([sw, sh]) => Math.abs(sw - w) > 3 || Math.abs(sh - h) > 3)
    return {
      status: doc.isEncrypted ? 'encrypted' : 'ok',
      pageCount: pages.length,
      pageWidthMm: w,
      pageHeightMm: h,
      mixedPageSizes: mixed,
    }
  } catch {
    return empty('unreadable')
  }
}
