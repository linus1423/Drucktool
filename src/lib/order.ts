// Regeln des Bestell-Wizards (Lastenheft 3.2). Wird im Browser für die Vorschau
// und auf dem Server beim Absenden genutzt, damit beide dasselbe prüfen.
import { z } from 'zod'
import type { CatalogTexts, Pricing } from './catalog'

export type CatalogFormat = {
  id: string
  label: string
  kind: 'print' | 'plot' | 'custom'
  widthMm: number | null
  heightMm: number | null
  allowsDuplex: boolean
  available: boolean
  helpText: string
}

export type CatalogBinding = {
  id: string
  label: string
  priceCents: number
  priceUnit: 'copy' | 'sheet'
  setupFeeCents: number
  allowsDuplex: boolean
  allowsCover: boolean
  allowsSplitCover: boolean
  trimmed: boolean
  available: boolean
  helpText: string
}

export type CatalogPaper = {
  id: string
  name: string
  grammage: number
  priceA3Cents: number | null
  priceSra3Cents: number | null
  priceA0Cents: number | null
  priceA1Cents: number | null
  priceA2Cents: number | null
  forCover: boolean
  forInner: boolean
  forPlotter: boolean
  maxFormatId: string | null
  available: boolean
  helpText: string
}

export type CatalogCoverColor = { id: string; name: string; hex: string | null; transparent: boolean; available: boolean }

/** Der Teil des Katalogs, den Wizard und Preisberechnung brauchen. */
export type OrderCatalog = {
  formats: CatalogFormat[]
  bindings: CatalogBinding[]
  formatBindings: { formatId: string; bindingId: string }[]
  papers: CatalogPaper[]
  coverColors: CatalogCoverColor[]
  pricing: Pricing
  texts: CatalogTexts
}

export const DELIVERY_METHODS = ['pickup', 'house_post'] as const
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number]
export const DELIVERY_LABELS: Record<DeliveryMethod, string> = {
  pickup: 'Abholung im Regal',
  house_post: 'Lieferung per Hauspost',
}

/** Größtes Sonderformat: ein SRA3-Bogen. */
export const CUSTOM_MAX_MM = { short: 320, long: 450 }
export const CUSTOM_MIN_MM = 20
/** Ein Deckblatt besteht aus höchstens zwei Seiten: vorne und hinten. */
export const MAX_COVER_PAGES = 2

/**
 * Seiten der Druckdatei, die bei einem Deckblatt aus der Druckdatei je Deckblatt
 * genutzt werden: doppelseitig Außen- und Innenseite, einseitig nur die Außenseite.
 */
export function coverPagesPerSheet(duplex: boolean) {
  return duplex ? 2 : 1
}

/**
 * Welche Seiten der Druckdatei auf das Deckblattpapier kommen, oder null, wenn das
 * Deckblatt eine eigene Datei hat. Für Hinweise im Wizard und auf der Detailseite.
 */
export function coverPagesFromMainFile(spec: Pick<OrderSpec, 'coverPages' | 'coverFromMainFile' | 'duplex' | 'pages'>) {
  if (!spec.coverFromMainFile || !spec.coverPages) return null
  const perSheet = coverPagesPerSheet(spec.duplex)
  const range = (from: number, to: number) => (from === to ? `Seite ${from}` : `Seiten ${from}–${to}`)
  return {
    /** Seiten, die damit nicht mehr im Innenteil gedruckt werden */
    taken: perSheet * spec.coverPages,
    front: range(1, perSheet),
    back: spec.coverPages === 2 ? range(spec.pages - perSheet + 1, spec.pages) : null,
  }
}

export const orderSpecSchema = z.object({
  formatId: z.string().min(1, 'Bitte ein Format wählen').max(50),
  customWidthMm: z.number().int().min(CUSTOM_MIN_MM).max(CUSTOM_MAX_MM.long).nullable(),
  customHeightMm: z.number().int().min(CUSTOM_MIN_MM).max(CUSTOM_MAX_MM.long).nullable(),
  bindingId: z.string().min(1, 'Bitte eine Bindung wählen').max(50),
  duplex: z.boolean(),
  paperId: z.uuid('Bitte ein Papier wählen'),
  /** Separates Deckblatt auf eigenem Papier. */
  coverPaperId: z.uuid().nullable(),
  /** Deckblätter: 1 = nur vorne, 2 = vorne und hinten. Mit eigener Datei deren Seitenzahl. */
  coverPages: z.number().int().min(1).max(MAX_COVER_PAGES).nullable(),
  /**
   * Ohne eigene Deckblatt-Datei (Issue #85) kommt das Deckblatt aus der Druckdatei:
   * die ersten Seiten für vorne, ggf. die letzten für hinten. Fehlt in älteren Aufträgen.
   */
  coverFromMainFile: z.boolean().default(false),
  coverColorId: z.uuid().nullable(),
  coverBackColorId: z.uuid().nullable(),
  borderless: z.boolean(),
  copies: z.number().int().min(1, 'Mindestens ein Exemplar').max(100_000),
  pages: z.number().int().min(1, 'Mindestens eine Seite').max(10_000),
  delivery: z.enum(DELIVERY_METHODS),
})
export type OrderSpec = z.infer<typeof orderSpecSchema>

export type Size = { widthMm: number; heightMm: number }

/** Maße des Endformats; beim Sonderformat die Eingabe des Kunden. */
export function formatSize(format: CatalogFormat, spec?: Pick<OrderSpec, 'customWidthMm' | 'customHeightMm'>): Size | null {
  if (format.kind === 'custom') {
    if (!spec?.customWidthMm || !spec.customHeightMm) return null
    return { widthMm: spec.customWidthMm, heightMm: spec.customHeightMm }
  }
  if (!format.widthMm || !format.heightMm) return null
  return { widthMm: format.widthMm, heightMm: format.heightMm }
}

const sorted = (s: Size) => [Math.min(s.widthMm, s.heightMm), Math.max(s.widthMm, s.heightMm)] as const

/** Passt a (in beliebiger Ausrichtung) in b? */
export function fitsWithin(a: Size, b: Size) {
  const [as, al] = sorted(a)
  const [bs, bl] = sorted(b)
  return as <= bs && al <= bl
}

/** Wie oft passt ein Stück auf einen Bogen (beide Ausrichtungen, ohne Mischung). */
export function piecesPerSheet(piece: Size, sheet: Size) {
  const fit = (w: number, h: number) => Math.floor(sheet.widthMm / w) * Math.floor(sheet.heightMm / h)
  return Math.max(fit(piece.widthMm, piece.heightMm), fit(piece.heightMm, piece.widthMm))
}

// ---------------------------------------------------------------------------
// Druckbogen und randloser Druck (Lastenheft Schritt 5, Issue #43)
// ---------------------------------------------------------------------------

export const SHEETS = {
  A4: { widthMm: 210, heightMm: 297 },
  A3: { widthMm: 297, heightMm: 420 },
  SRA3: { widthMm: 320, heightMm: 450 },
} as const
export type SheetKind = keyof typeof SHEETS

/** Beschnittzugabe je Seite und nicht bedruckbarer Rand des Druckers. */
export const BLEED_MM = 3
export const PRINTER_MARGIN_MM = 4

export type Imposition = {
  sheet: SheetKind
  /** Stück pro Bogen */
  ups: number
  /** Papier wird pro A3- bzw. SRA3-Bogen berechnet; aus einem A3-Bogen werden zwei A4-Bögen. */
  paperSheet: 'A3' | 'SRA3'
  sheetsPerPaperSheet: number
  paperSheetPriceCents: number
  /** Randlos über größeren Bogen und Zuschnitt */
  bleed: boolean
}

function sheetPrice(paper: CatalogPaper, sheet: SheetKind): number | null {
  return sheet === 'SRA3' ? paper.priceSra3Cents : paper.priceA3Cents
}

function imposition(sheet: SheetKind, ups: number, price: number, bleed: boolean): Imposition {
  return {
    sheet,
    ups,
    paperSheet: sheet === 'SRA3' ? 'SRA3' : 'A3',
    sheetsPerPaperSheet: sheet === 'A4' ? 2 : 1,
    paperSheetPriceCents: price,
    bleed,
  }
}

/**
 * Bestimmt den Druckbogen. Der normale Drucker druckt nicht randlos: Randlose
 * Stücke werden mit Beschnitt auf SRA3 gedruckt und zugeschnitten. Bindungen,
 * die ohnehin zugeschnitten werden (Leimbindung), brauchen das nicht.
 */
export function impose(
  size: Size,
  paper: CatalogPaper,
  options: { borderless: boolean; trimmed: boolean },
): Imposition | { error: string } {
  const bleed = options.borderless && !options.trimmed
  if (bleed) {
    const piece = { widthMm: size.widthMm + 2 * BLEED_MM, heightMm: size.heightMm + 2 * BLEED_MM }
    const printable = {
      widthMm: SHEETS.SRA3.widthMm - 2 * PRINTER_MARGIN_MM,
      heightMm: SHEETS.SRA3.heightMm - 2 * PRINTER_MARGIN_MM,
    }
    const ups = piecesPerSheet(piece, printable)
    if (ups === 0) return { error: 'Das Format ist für randlosen Druck zu groß.' }
    const price = sheetPrice(paper, 'SRA3')
    if (price == null) return { error: `${paper.name} gibt es nicht im Bogenformat SRA3, randlos ist damit nicht möglich.` }
    return imposition('SRA3', ups, price, bleed)
  }
  for (const sheet of ['A4', 'A3', 'SRA3'] as const) {
    const ups = piecesPerSheet(size, SHEETS[sheet])
    const price = sheetPrice(paper, sheet)
    if (ups > 0 && price != null) return imposition(sheet, ups, price, bleed)
  }
  return { error: `Das Format passt mit ${paper.name} auf keinen Druckbogen.` }
}

// ---------------------------------------------------------------------------
// Auswahlmöglichkeiten im Wizard
// ---------------------------------------------------------------------------

export type Choice<T> = { item: T; allowed: boolean; reason?: string }

export function findFormat(catalog: OrderCatalog, id: string) {
  return catalog.formats.find((f) => f.id === id)
}

export function bindingChoices(catalog: OrderCatalog, format: CatalogFormat | undefined): Choice<CatalogBinding>[] {
  return catalog.bindings.map((binding) => {
    if (!format) return { item: binding, allowed: false, reason: 'Bitte zuerst ein Format wählen.' }
    const ok = catalog.formatBindings.some((fb) => fb.formatId === format.id && fb.bindingId === binding.id)
    return ok ? { item: binding, allowed: true } : { item: binding, allowed: false, reason: `Mit ${format.label} nicht möglich.` }
  })
}

export function duplexChoice(format: CatalogFormat | undefined, binding: CatalogBinding | undefined): Choice<null> {
  if (format && !format.allowsDuplex) {
    return {
      item: null,
      allowed: false,
      reason: format.kind === 'plot' ? 'Plots werden nur einseitig gedruckt.' : `${format.label} nur einseitig.`,
    }
  }
  if (binding && !binding.allowsDuplex) return { item: null, allowed: false, reason: `${binding.label} nur einseitig.` }
  return { item: null, allowed: true }
}

function plotPrice(paper: CatalogPaper, formatId: string): number | null {
  if (formatId === 'A0') return paper.priceA0Cents
  if (formatId === 'A1') return paper.priceA1Cents
  if (formatId === 'A2') return paper.priceA2Cents
  return null
}

export function paperChoices(
  catalog: OrderCatalog,
  format: CatalogFormat | undefined,
  size: Size | null,
  purpose: 'inner' | 'cover',
): Choice<CatalogPaper>[] {
  return catalog.papers.map((paper) => {
    if (!format) return { item: paper, allowed: false, reason: 'Bitte zuerst ein Format wählen.' }
    if (format.kind === 'plot') {
      if (purpose === 'cover') return { item: paper, allowed: false, reason: 'Plots haben kein Deckblatt.' }
      if (!paper.forPlotter) return { item: paper, allowed: false, reason: 'Nicht für den Plotter.' }
      if (plotPrice(paper, format.id) == null) return { item: paper, allowed: false, reason: `Nicht in ${format.label}.` }
      return { item: paper, allowed: true }
    }
    if (purpose === 'inner' && !paper.forInner) return { item: paper, allowed: false, reason: 'Nur für Deckblätter.' }
    if (purpose === 'cover' && !paper.forCover) return { item: paper, allowed: false, reason: 'Nicht für Deckblätter geeignet.' }
    if (paper.priceA3Cents == null && paper.priceSra3Cents == null) {
      return { item: paper, allowed: false, reason: 'Nicht für den normalen Drucker.' }
    }
    if (paper.maxFormatId && size) {
      const max = findFormat(catalog, paper.maxFormatId)
      const maxSize = max ? formatSize(max) : null
      if (maxSize && !fitsWithin(size, maxSize)) return { item: paper, allowed: false, reason: `Höchstens ${max!.label}.` }
    }
    return { item: paper, allowed: true }
  })
}

export type BorderlessChoice = Choice<null> & { note?: string }

/** Randlos geht, wenn zugeschnitten wird: über SRA3 mit Beschnitt oder durch die Bindung. */
export function borderlessChoice(
  format: CatalogFormat | undefined,
  binding: CatalogBinding | undefined,
  paper: CatalogPaper | undefined,
  size: Size | null,
): BorderlessChoice {
  if (!format || !binding || !paper || !size)
    return { item: null, allowed: false, reason: 'Erst Format, Bindung und Papier wählen.' }
  if (format.kind === 'plot') return { item: null, allowed: false, reason: 'Beim Plotter nicht wählbar.' }
  if (binding.trimmed) {
    return {
      item: null,
      allowed: true,
      note: `Bei ${binding.label} wird das Buch immer zugeschnitten. Randlos ist deshalb möglich, das Buch wird aber ein paar Millimeter kleiner als ${format.label}.`,
    }
  }
  const result = impose(size, paper, { borderless: true, trimmed: false })
  if ('error' in result) return { item: null, allowed: false, reason: result.error }
  return {
    item: null,
    allowed: true,
    note: 'Wir drucken auf einen größeren Bogen und schneiden auf das Endformat zu. Wichtige Inhalte bitte mindestens 3 mm vom Rand entfernt halten.',
  }
}

export function coverColorChoices(catalog: OrderCatalog, binding: CatalogBinding | undefined): Choice<CatalogCoverColor>[] {
  return catalog.coverColors.map((color) => {
    if (!binding?.allowsCover) return { item: color, allowed: false, reason: 'Bei dieser Bindung gibt es keine Coverfarbe.' }
    if (color.transparent && !binding.allowsSplitCover) {
      return { item: color, allowed: false, reason: `Durchsichtig gibt es bei ${binding.label} nicht.` }
    }
    return { item: color, allowed: true }
  })
}

// ---------------------------------------------------------------------------
// Gesamtprüfung
// ---------------------------------------------------------------------------

export type ResolvedOrder = {
  format: CatalogFormat
  size: Size
  binding: CatalogBinding
  paper: CatalogPaper
  coverPaper: CatalogPaper | null
  coverColor: CatalogCoverColor | null
  coverBackColor: CatalogCoverColor | null
}

/** Prüft eine Bestellung gegen den Katalog. Liefert Fehler in Kundensprache. */
export function resolveOrder(
  catalog: OrderCatalog,
  spec: OrderSpec,
): { ok: true; order: ResolvedOrder } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const fail = (message: string) => ({ ok: false as const, errors: [...errors, message] })

  const format = catalog.formats.find((f) => f.id === spec.formatId && f.available)
  if (!format) return fail('Das gewählte Format ist nicht verfügbar.')
  const size = formatSize(format, spec)
  if (!size) return fail('Bitte Breite und Höhe des Sonderformats angeben.')
  if (format.kind === 'custom' && !fitsWithin(size, { widthMm: CUSTOM_MAX_MM.short, heightMm: CUSTOM_MAX_MM.long })) {
    return fail(`Ein Sonderformat darf höchstens ${CUSTOM_MAX_MM.short} × ${CUSTOM_MAX_MM.long} mm groß sein.`)
  }

  const binding = catalog.bindings.find((b) => b.id === spec.bindingId && b.available)
  if (!binding) return fail('Die gewählte Bindung ist nicht verfügbar.')
  const bindingOk = bindingChoices(catalog, format).find((c) => c.item.id === binding.id)
  if (!bindingOk?.allowed) return fail(`${binding.label} ist mit ${format.label} nicht möglich.`)

  if (spec.duplex) {
    const duplex = duplexChoice(format, binding)
    if (!duplex.allowed) errors.push(`Doppelseitig ist nicht möglich: ${duplex.reason}`)
  }

  const paper = catalog.papers.find((p) => p.id === spec.paperId && p.available)
  if (!paper) return fail('Das gewählte Papier ist nicht verfügbar.')
  const paperOk = paperChoices(catalog, format, size, 'inner').find((c) => c.item.id === paper.id)
  if (!paperOk?.allowed) errors.push(`${paper.name}: ${paperOk?.reason ?? 'nicht wählbar'}`)

  let coverPaper: CatalogPaper | null = null
  if (spec.coverPaperId) {
    if (!binding.allowsCover) errors.push(`Ein separates Deckblatt gibt es bei ${binding.label} nicht.`)
    coverPaper = catalog.papers.find((p) => p.id === spec.coverPaperId && p.available) ?? null
    if (!coverPaper) errors.push('Das Deckblattpapier ist nicht verfügbar.')
    else {
      const ok = paperChoices(catalog, format, size, 'cover').find((c) => c.item.id === coverPaper!.id)
      if (!ok?.allowed) errors.push(`${coverPaper.name}: ${ok?.reason ?? 'nicht als Deckblatt wählbar'}`)
    }
    if (!spec.coverPages) {
      errors.push(
        spec.coverFromMainFile
          ? 'Bitte angeben, ob das Deckblatt nur vorne oder vorne und hinten ist.'
          : 'Bitte die Datei für das Deckblatt hochladen.',
      )
    }
    const fromMain = coverPagesFromMainFile(spec)
    if (fromMain && fromMain.taken >= spec.pages) {
      errors.push(
        `Für ein Deckblatt aus der Druckdatei braucht die Datei mehr als ${fromMain.taken} Seiten. Bitte eine eigene Deckblatt-Datei hochladen.`,
      )
    }
  } else if (spec.coverFromMainFile) {
    errors.push('Ein Deckblatt ist nicht ausgewählt.')
  }

  const colorFor = (id: string | null, label: string) => {
    if (!id) return null
    const choice = coverColorChoices(catalog, binding).find((c) => c.item.id === id && c.item.available)
    if (!choice) {
      errors.push(`Die Coverfarbe ${label} ist nicht verfügbar.`)
      return null
    }
    if (!choice.allowed) errors.push(choice.reason!)
    return choice.item
  }
  const coverColor = colorFor(spec.coverColorId, 'vorne')
  const coverBackColor = colorFor(spec.coverBackColorId, 'hinten')
  if (coverBackColor && !binding.allowsSplitCover && coverBackColor.id !== coverColor?.id) {
    errors.push(`Unterschiedliche Coverfarben vorne und hinten gibt es bei ${binding.label} nicht.`)
  }

  if (spec.borderless) {
    const choice = borderlessChoice(format, binding, paper, size)
    if (!choice.allowed) errors.push(`Randlos ist nicht möglich: ${choice.reason}`)
  }

  if (binding.id === 'saddle_stitch' && spec.pages % 4 !== 0) {
    errors.push('Für ein Booklet muss die Seitenzahl durch 4 teilbar sein. Leere Seiten bitte in der Datei ergänzen.')
  }

  if (errors.length) return { ok: false, errors }
  return { ok: true, order: { format, size, binding, paper, coverPaper, coverColor, coverBackColor } }
}

/** Vorschlag für das Endformat aus der Seitengröße einer PDF (±3 mm). */
export function suggestFormat(formats: CatalogFormat[], page: Size): CatalogFormat | undefined {
  const [ps, pl] = sorted(page)
  return formats.find((f) => {
    if (!f.available || f.kind === 'custom' || !f.widthMm || !f.heightMm) return false
    const [fs, fl] = sorted({ widthMm: f.widthMm, heightMm: f.heightMm })
    return Math.abs(fs - ps) <= 3 && Math.abs(fl - pl) <= 3
  })
}
