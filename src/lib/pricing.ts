// Preisberechnung (Lastenheft Schritt 7, Issue #45). Alle Beträge in Cent.
// Dieselbe Funktion rechnet die Vorschau im Browser und den verbindlichen Preis auf dem Server.
import { coverPagesFromMainFile, impose, resolveOrder, type Imposition, type OrderCatalog, type OrderSpec, type ResolvedOrder } from './order'

export type PriceGroup = 'print' | 'delivery'

export type PriceLine = {
  key: string
  label: string
  /** Rechenweg für Mitarbeiter, z. B. "40 × 0,10 €" */
  detail: string
  amountCents: number
  group: PriceGroup
}

export type PriceResult = {
  lines: PriceLine[]
  /** Kunden sehen nur Druckkosten (inkl. Mindestpreis) und Lieferkosten. */
  printCents: number
  deliveryCents: number
  totalCents: number
  inner: Imposition | null
  cover: Imposition | null
}

const euro = (cents: number) =>
  (cents / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'
const times = (count: number, unitCents: number) => `${count.toLocaleString('de-DE')} × ${euro(unitCents)}`

const SHEET_LABEL = { A4: 'A4', A3: 'A3', SRA3: 'SRA3' } as const

/** Bögen für eine Anzahl Stücke und die Klicks (bedruckte Seiten) darauf. */
function sheetsFor(pieces: number, imp: Imposition, sides: 1 | 2) {
  const sheets = Math.ceil(pieces / imp.ups)
  return { sheets, clicks: sheets * sides, paperSheets: Math.ceil(sheets / imp.sheetsPerPaperSheet) }
}

function plotPriceOf(order: ResolvedOrder): number {
  const p = order.paper
  const price = order.format.id === 'A0' ? p.priceA0Cents : order.format.id === 'A1' ? p.priceA1Cents : p.priceA2Cents
  if (price == null) throw new Error(`${p.name} hat keinen Preis für ${order.format.label}`)
  return price
}

export function calculatePrice(
  catalog: OrderCatalog,
  spec: OrderSpec,
): { ok: true; price: PriceResult; order: ResolvedOrder } | { ok: false; errors: string[] } {
  const resolved = resolveOrder(catalog, spec)
  if (!resolved.ok) return resolved
  const { order } = resolved
  const { pricing } = catalog
  const lines: PriceLine[] = []
  let inner: Imposition | null = null
  let cover: Imposition | null = null
  const add = (line: Omit<PriceLine, 'group'>, group: PriceGroup = 'print') => {
    if (line.amountCents !== 0) lines.push({ ...line, group })
  }

  const isPlot = order.format.kind === 'plot'
  if (isPlot) {
    // Plots: Pauschalpreis pro Plot je Format, Papier und Druck inklusive.
    const plots = spec.pages * spec.copies
    const unit = plotPriceOf(order)
    add({
      key: 'plot',
      label: `Plot ${order.format.label} auf ${order.paper.name}`,
      detail: times(plots, unit),
      amountCents: plots * unit,
    })
  } else {
    const flags = { borderless: spec.borderless, trimmed: order.binding.trimmed }
    const imp = impose(order.size, order.paper, flags)
    if ('error' in imp) return { ok: false, errors: [imp.error] }
    inner = imp
    const sides = spec.duplex ? 2 : 1
    // Kommt das Deckblatt aus der Druckdatei, werden diese Seiten nur auf dem Deckblatt
    // gedruckt und berechnet, nicht zusätzlich im Innenteil (Issue #85).
    const fromMain = order.coverPaper ? coverPagesFromMainFile(spec) : null
    const innerPages = spec.pages - (fromMain?.taken ?? 0)
    const piecesPerCopy = spec.duplex ? Math.ceil(innerPages / 2) : innerPages
    const run = sheetsFor(piecesPerCopy * spec.copies, imp, sides)
    const click = imp.sheet === 'A4' ? pricing.printA4Cents : pricing.printA3Cents
    add({
      key: 'print',
      label: `Farbdruck ${SHEET_LABEL[imp.sheet]}${spec.duplex ? ', doppelseitig' : ''}`,
      detail: `${times(run.clicks, click)} (${run.sheets} Bögen, ${imp.ups} pro Bogen${imp.bleed ? ', mit Beschnitt' : ''})`,
      amountCents: run.clicks * click,
    })
    add({
      key: 'paper',
      label: `Papier ${order.paper.name} ${order.paper.grammage} g/m²`,
      detail: `${times(run.paperSheets, imp.paperSheetPriceCents)} pro ${imp.paperSheet}-Bogen`,
      amountCents: run.paperSheets * imp.paperSheetPriceCents,
    })

    let coverPiecesPerCopy = 0
    if (order.coverPaper && spec.coverPages) {
      const coverImp = impose(order.size, order.coverPaper, flags)
      if ('error' in coverImp) return { ok: false, errors: [`Deckblatt: ${coverImp.error}`] }
      cover = coverImp
      // Jede Seite der Deckblatt-Datei ist ein einseitig bedrucktes Blatt (vorne, ggf. hinten).
      // Aus der Druckdatei wird das Deckblatt wie der Innenteil ein- oder doppelseitig bedruckt.
      coverPiecesPerCopy = spec.coverPages
      const coverSides = fromMain ? sides : 1
      const coverRun = sheetsFor(coverPiecesPerCopy * spec.copies, coverImp, coverSides)
      const coverClick = coverImp.sheet === 'A4' ? pricing.printA4Cents : pricing.printA3Cents
      add({
        key: 'cover_print',
        label: `Deckblatt Farbdruck ${SHEET_LABEL[coverImp.sheet]}${coverSides === 2 ? ', doppelseitig' : ''}`,
        detail: `${times(coverRun.clicks, coverClick)} (${coverRun.sheets} Bögen, ${coverImp.ups} pro Bogen)`,
        amountCents: coverRun.clicks * coverClick,
      })
      add({
        key: 'cover_paper',
        label: `Deckblatt ${order.coverPaper.name} ${order.coverPaper.grammage} g/m²`,
        detail: `${times(coverRun.paperSheets, coverImp.paperSheetPriceCents)} pro ${coverImp.paperSheet}-Bogen`,
        amountCents: coverRun.paperSheets * coverImp.paperSheetPriceCents,
      })
    }

    const b = order.binding
    if (b.priceUnit === 'sheet') {
      const sheets = (piecesPerCopy + coverPiecesPerCopy) * spec.copies
      add({
        key: 'binding',
        label: b.label,
        detail: `${times(sheets, b.priceCents)} pro Blatt`,
        amountCents: sheets * b.priceCents,
      })
    } else {
      add({
        key: 'binding',
        label: b.label,
        detail: `${times(spec.copies, b.priceCents)} pro Exemplar`,
        amountCents: spec.copies * b.priceCents,
      })
    }
    add({ key: 'setup', label: `${b.label}, einmalig`, detail: 'pro Auftrag', amountCents: b.setupFeeCents })
  }

  const subtotal = lines.reduce((sum, l) => sum + l.amountCents, 0)
  if (subtotal < pricing.minimumOrderCents) {
    add({
      key: 'minimum',
      label: 'Aufschlag auf den Mindestpreis',
      detail: `Mindestpreis ${euro(pricing.minimumOrderCents)}`,
      amountCents: pricing.minimumOrderCents - subtotal,
    })
  }

  if (spec.delivery === 'house_post') {
    const fee = isPlot ? pricing.housePostPlotCents : pricing.housePostCents
    add(
      { key: 'delivery', label: isPlot ? 'Hauspost für Plots' : 'Hauspost', detail: 'pro Auftrag', amountCents: fee },
      'delivery',
    )
  }

  const printCents = lines.filter((l) => l.group === 'print').reduce((s, l) => s + l.amountCents, 0)
  const deliveryCents = lines.filter((l) => l.group === 'delivery').reduce((s, l) => s + l.amountCents, 0)
  return { ok: true, order, price: { lines, printCents, deliveryCents, totalCents: printCents + deliveryCents, inner, cover } }
}
