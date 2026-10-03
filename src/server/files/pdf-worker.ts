// Wertet eine PDF in einem eigenen Prozess aus (siehe pdf.server.ts). Absichtlich ohne Importe aus
// dem Projekt, damit Node die Datei im Entwicklungsbetrieb direkt laden kann; für den Betrieb bündelt
// esbuild sie nach .output/scripts/pdf-worker.mjs.
import { readFile } from 'node:fs/promises'
import { PDFDocument } from 'pdf-lib'

const PT_TO_MM = 25.4 / 72

async function analyse(file: string) {
  const doc = await PDFDocument.load(await readFile(file), {
    ignoreEncryption: true,
    updateMetadata: false,
    throwOnInvalidObject: false,
  })
  const pages = doc.getPages()
  if (pages.length === 0) return null
  const sizes = pages.map((page) => {
    // Das Endformat steht in der TrimBox; die MediaBox enthält bei Druck-PDFs zusätzlich den Beschnitt (Issue #135).
    // pdf-lib fällt ohne TrimBox auf CropBox und MediaBox zurück.
    const { width, height } = page.getTrimBox()
    const rotated = page.getRotation().angle % 180 !== 0
    const w = Math.round((rotated ? height : width) * PT_TO_MM)
    const h = Math.round((rotated ? width : height) * PT_TO_MM)
    return [w, h] as const
  })
  const [w, h] = sizes[0]!
  return {
    status: doc.isEncrypted ? ('encrypted' as const) : ('ok' as const),
    pageCount: pages.length,
    pageWidthMm: w,
    pageHeightMm: h,
    mixedPageSizes: sizes.some(([sw, sh]) => Math.abs(sw - w) > 3 || Math.abs(sh - h) > 3),
  }
}

const send = (message: unknown) => process.send?.(message, () => process.exit(0))
analyse(process.argv[2] ?? '').then(send, () => send(null))
