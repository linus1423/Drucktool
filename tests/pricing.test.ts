import { describe, expect, it } from 'vitest'
import {
  borderlessChoice,
  bindingChoices,
  bookletWarning,
  findFormat,
  formatSize,
  impose,
  orderSpecSchema,
  paperChoices,
  piecesPerSheet,
  resolveOrder,
  suggestFormat,
} from '~/lib/order'
import { calculatePrice } from '~/lib/pricing'
import { CATALOG, COLOR, PAPER, spec } from './order-catalog'

function price(overrides: Parameters<typeof spec>[0]) {
  const result = calculatePrice(CATALOG, spec(overrides))
  if (!result.ok) throw new Error(result.errors.join('; '))
  return result.price
}

function errors(overrides: Parameters<typeof spec>[0]) {
  const result = calculatePrice(CATALOG, spec(overrides))
  return result.ok ? [] : result.errors
}

const amount = (p: ReturnType<typeof price>, key: string) => p.lines.find((l) => l.key === key)?.amountCents ?? 0

describe('Druckbogen', () => {
  it('rechnet Nutzen in beiden Ausrichtungen', () => {
    expect(piecesPerSheet({ widthMm: 148, heightMm: 210 }, { widthMm: 210, heightMm: 297 })).toBe(2)
    expect(piecesPerSheet({ widthMm: 85, heightMm: 55 }, { widthMm: 297, heightMm: 420 })).toBe(21)
  })

  it('druckt randlose Formate mit Beschnitt auf SRA3', () => {
    const paper = CATALOG.papers.find((p) => p.id === PAPER.standard)!
    const imp = impose({ widthMm: 210, heightMm: 297 }, paper, { borderless: true, trimmed: false })
    expect(imp).toMatchObject({ sheet: 'SRA3', ups: 2, bleed: true })
    const a3 = impose({ widthMm: 297, heightMm: 420 }, paper, { borderless: true, trimmed: false })
    expect(a3).toMatchObject({ sheet: 'SRA3', ups: 1 })
  })

  it('braucht bei Leimbindung keinen größeren Bogen für randlos', () => {
    const paper = CATALOG.papers.find((p) => p.id === PAPER.standard)!
    expect(impose({ widthMm: 210, heightMm: 297 }, paper, { borderless: true, trimmed: true })).toMatchObject({
      sheet: 'A4',
      bleed: false,
    })
  })
})

describe('Auswahlregeln', () => {
  it('bietet nur Bindungen aus der Matrix an', () => {
    const allowed = bindingChoices(CATALOG, findFormat(CATALOG, 'A3'))
      .filter((c) => c.allowed)
      .map((c) => c.item.id)
    expect(allowed).toEqual(['loose', 'corner_staple', 'laminated'])
    expect(errors({ formatId: 'A3', bindingId: 'glue' })).toEqual(['Leimbindung ist mit A3 nicht möglich.'])
  })

  it('erlaubt bei Plots weder doppelseitig noch randlos', () => {
    expect(errors({ formatId: 'A1', paperId: PAPER.plot, duplex: true })[0]).toContain('Plots werden nur einseitig')
    const format = findFormat(CATALOG, 'A1')
    expect(borderlessChoice(format, CATALOG.bindings[0], CATALOG.papers[3], { widthMm: 594, heightMm: 841 }).allowed).toBe(false)
  })

  it('lehnt randlos ab, wenn das Papier kein SRA3 hat', () => {
    expect(errors({ borderless: true, paperId: PAPER.noSra3 })[0]).toContain('SRA3')
  })

  it('weist beim Booklet nur auf fehlende Seiten hin und rechnet die Leerseiten mit (Issue #103)', () => {
    const booklet = { bindingId: 'saddle_stitch' }
    expect(errors({ ...booklet, duplex: true, pages: 6 })).toEqual([])
    expect(bookletWarning(spec({ ...booklet, duplex: true, pages: 6 }))).toContain('ergänzen wir am Ende der Datei 2 Leerseiten')
    expect(bookletWarning(spec({ ...booklet, duplex: true, pages: 8 }))).toBeNull()
    expect(bookletWarning(spec({ ...booklet, duplex: false, pages: 5 }))).toContain('eine Leerseite')
    expect(bookletWarning(spec({ ...booklet, duplex: false, pages: 6 }))).toBeNull()
    expect(bookletWarning(spec({ bindingId: 'glue', duplex: true, pages: 6 }))).toBeNull()
    expect(price({ ...booklet, duplex: true, pages: 6 }).totalCents).toBe(
      price({ ...booklet, duplex: true, pages: 8 }).totalCents,
    )
    expect(price({ ...booklet, duplex: false, pages: 5 }).totalCents).toBe(
      price({ ...booklet, duplex: false, pages: 6 }).totalCents,
    )
  })

  it('erlaubt durchsichtiges Cover nur bei geteiltem Cover', () => {
    expect(errors({ bindingId: 'glue', coverColorId: COLOR.clear })[0]).toContain('Durchsichtig gibt es bei Leimbindung nicht')
    expect(errors({ bindingId: 'plastic_comb', coverColorId: COLOR.clear, coverBackColorId: COLOR.white })).toEqual([])
    expect(errors({ bindingId: 'loose', coverColorId: COLOR.white })[0]).toContain('keine Coverfarbe')
  })

  it('erlaubt nur Coverfarben, die es auf dem Deckblattpapier gibt', () => {
    const cover = { bindingId: 'plastic_comb', coverPages: 1 }
    expect(errors({ ...cover, coverPaperId: PAPER.card, coverColorId: COLOR.white })).toEqual([])
    expect(errors({ ...cover, coverPaperId: PAPER.card, coverColorId: COLOR.blue })).toEqual([
      'Dunkelblau gibt es nicht auf Karton 300 g/m².',
    ])
    expect(errors({ ...cover, coverPaperId: PAPER.card, coverColorId: COLOR.white, coverBackColorId: COLOR.clear })[0]).toContain(
      'Durchsichtig gibt es nicht auf Karton',
    )
    expect(errors({ ...cover, coverPaperId: PAPER.thick, coverColorId: COLOR.blue, coverBackColorId: COLOR.clear })).toEqual([])
    // Ohne separates Deckblatt gilt nur die Bindung.
    expect(errors({ bindingId: 'plastic_comb', coverColorId: COLOR.blue })).toEqual([])
  })

  it('prüft Papier gegen Zweck und größtes Format', () => {
    expect(errors({ paperId: PAPER.card })[0]).toContain('Nur für Deckblätter')
    expect(errors({ formatId: 'custom', customWidthMm: 320, customHeightMm: 450 })[0]).toContain('Höchstens A3')
    expect(errors({ formatId: 'custom', customWidthMm: 330, customHeightMm: 450 })[0]).toContain('höchstens 320 × 450')
    expect(errors({ formatId: 'custom' })[0]).toContain('Breite und Höhe')
  })

  it('blendet reine Plotterpapiere bei normalen Formaten ganz aus', () => {
    const a4 = findFormat(CATALOG, 'A4')!
    const ids = (purpose: 'inner' | 'cover') => paperChoices(CATALOG, a4, formatSize(a4), purpose).map((c) => c.item.id)
    expect(ids('inner')).not.toContain(PAPER.plot)
    expect(ids('cover')).not.toContain(PAPER.plot)
    const a1 = findFormat(CATALOG, 'A1')!
    const plot = paperChoices(CATALOG, a1, formatSize(a1), 'inner').find((c) => c.item.id === PAPER.plot)
    expect(plot?.allowed).toBe(true)
    expect(errors({ paperId: PAPER.plot })).toEqual(['Plotterpapier: Nur für den Plotter.'])
    expect(errors({ bindingId: 'glue', coverPaperId: PAPER.plot, coverPages: 1 })).toEqual([
      'Plotterpapier: Nur für den Plotter.',
    ])
  })

  it('prüft das Deckblatt unabhängig von der Seitenzahl der Datei', () => {
    // Unlesbare Deckblatt-Dateien haben keine Seitenzahl; die Datei selbst prüft createRequest.
    expect(errors({ bindingId: 'plastic_comb', coverPaperId: PAPER.card })).toEqual([])
    expect(errors({ bindingId: 'loose', coverPaperId: PAPER.card, coverPages: 1 })[0]).toContain(
      'Ein separates Deckblatt gibt es bei Lose nicht',
    )
  })

  it('erlaubt ein Deckblatt ohne eigene Datei aus der Druckdatei', () => {
    const cover = { bindingId: 'plastic_comb', coverPaperId: PAPER.card }
    expect(errors({ ...cover, pages: 10, coverFromMainFile: 'frontBack' })).toEqual([])
    // Das Deckblatt ist immer beidseitig: vorne und hinten brauchen vier Seiten, auch einseitig.
    expect(errors({ ...cover, pages: 4, coverFromMainFile: 'frontBack' })[0]).toContain('mehr als 4 Seiten')
    expect(errors({ ...cover, pages: 2, coverFromMainFile: 'front' })[0]).toContain('mehr als 2 Seiten')
    expect(errors({ coverFromMainFile: 'front', pages: 4 })).toContain('Ein Deckblatt ist nicht ausgewählt.')
    // Ältere Aufträge kennen das Feld nicht.
    const { coverFromMainFile: _, ...old } = spec({ coverPaperId: PAPER.card, coverPages: 2 })
    expect(orderSpecSchema.parse(old).coverFromMainFile).toBeNull()
  })

  it('schlägt das Format anhand der PDF-Seitengröße vor', () => {
    expect(suggestFormat(CATALOG.formats, { widthMm: 297, heightMm: 210 })?.id).toBe('A4')
    expect(suggestFormat(CATALOG.formats, { widthMm: 200, heightMm: 200 })).toBeUndefined()
  })

  it('meldet nicht verfügbare Optionen', () => {
    const catalog = { ...CATALOG, papers: CATALOG.papers.map((p) => ({ ...p, available: p.id !== PAPER.standard })) }
    const result = resolveOrder(catalog, spec())
    expect(result.ok).toBe(false)
  })
})

describe('Preise', () => {
  it('A4 einseitig, 10 Seiten, 3 Exemplare', () => {
    const p = price({ pages: 10, copies: 3 })
    expect(amount(p, 'print')).toBe(30 * 10)
    expect(amount(p, 'paper')).toBe(15 * 2) // 30 A4-Bögen = 15 A3-Bögen
    expect(p.totalCents).toBe(330)
  })

  it('A4 doppelseitig halbiert das Papier, nicht den Druck', () => {
    const p = price({ pages: 10, copies: 3, duplex: true })
    expect(amount(p, 'print')).toBe(300)
    expect(amount(p, 'paper')).toBe(8 * 2)
  })

  it('Leimbindung mit Einmalkosten (Lastenheft: 2 € pro Exemplar, 7 € einmalig)', () => {
    const p = price({ bindingId: 'glue', pages: 100, copies: 2, duplex: true })
    expect(amount(p, 'print')).toBe(200 * 10)
    expect(amount(p, 'paper')).toBe(50 * 2)
    expect(amount(p, 'binding')).toBe(400)
    expect(amount(p, 'setup')).toBe(700)
    expect(p.totalCents).toBe(3200)
  })

  it('Dissertation 5 € und Booklet 1 € pro Exemplar', () => {
    expect(amount(price({ bindingId: 'glue_dissertation', copies: 3 }), 'binding')).toBe(1500)
    expect(amount(price({ bindingId: 'saddle_stitch', pages: 8, duplex: true, copies: 3 }), 'binding')).toBe(300)
  })

  it('Plots pauschal pro Format, Hauspost 2 € extra (Lastenheft)', () => {
    const p = price({ formatId: 'A1', paperId: PAPER.plot, pages: 2, delivery: 'house_post' })
    expect(amount(p, 'plot')).toBe(2 * 1200)
    expect(p.printCents).toBe(2400)
    expect(p.deliveryCents).toBe(200)
    expect(price({ formatId: 'A0', paperId: PAPER.plot }).totalCents).toBe(1500)
    expect(price({ formatId: 'A2', paperId: PAPER.plot }).totalCents).toBe(900)
  })

  it('hebt kleine Aufträge auf den Mindestpreis, ohne Lieferkosten', () => {
    const p = price({ formatId: 'A6', delivery: 'house_post' })
    expect(amount(p, 'print') + amount(p, 'paper')).toBe(12)
    expect(amount(p, 'minimum')).toBe(88)
    expect(p.printCents).toBe(100)
    expect(p.deliveryCents).toBe(0)
  })

  it('randlos über SRA3 mit A3-Druckpreis', () => {
    const p = price({ borderless: true, copies: 10 })
    expect(p.inner).toMatchObject({ sheet: 'SRA3', ups: 2 })
    expect(amount(p, 'print')).toBe(5 * 20)
    expect(amount(p, 'paper')).toBe(5 * 3)
  })

  it('Laminieren pro Blatt', () => {
    expect(amount(price({ bindingId: 'laminated', pages: 4, copies: 2 }), 'binding')).toBe(8 * 100)
  })

  it('separates Deckblatt auf Karton', () => {
    const p = price({ bindingId: 'plastic_comb', pages: 20, duplex: true, coverPaperId: PAPER.card, coverPages: 2 })
    expect(amount(p, 'print')).toBe(20 * 10)
    expect(amount(p, 'paper')).toBe(5 * 2)
    expect(amount(p, 'cover_print')).toBe(2 * 10)
    expect(amount(p, 'cover_paper')).toBe(1 * 15)
    expect(amount(p, 'binding')).toBe(200)
    expect(p.totalCents).toBe(445)
  })

  it('rechnet das Deckblatt unabhängig von seiner Seitenzahl als ein beidseitiges Blatt', () => {
    const base = { bindingId: 'plastic_comb', pages: 20, duplex: true, copies: 3, coverPaperId: PAPER.card }
    const one = price({ ...base, coverPages: 1 })
    const many = price({ ...base, coverPages: 7 })
    expect(many.totalCents).toBe(one.totalCents)
    expect(one.cover).toMatchObject({ sheet: 'A4', ups: 1 })
    // 3 Deckblätter: 3 A4-Bögen, beidseitig 6 Klicks, Papier 2 A3-Bögen.
    expect(amount(one, 'cover_print')).toBe(6 * 10)
    expect(amount(one, 'cover_paper')).toBe(2 * 15)
  })

  it('Deckblatt aus der Druckdatei: Seiten nicht doppelt berechnen', () => {
    const cover = { bindingId: 'plastic_comb', coverPaperId: PAPER.card }
    // Doppelseitig: Seiten 1–2 und 19–20 auf Karton, 16 Seiten im Innenteil.
    const p = price({ ...cover, pages: 20, duplex: true, coverFromMainFile: 'frontBack' })
    expect(amount(p, 'print')).toBe(16 * 10)
    expect(amount(p, 'paper')).toBe(4 * 2)
    expect(amount(p, 'cover_print')).toBe(4 * 10)
    expect(amount(p, 'cover_paper')).toBe(1 * 15)
    expect(p.totalCents).toBe(160 + 8 + 40 + 15 + 200)
    // Einseitiger Innenteil: das Deckblatt nimmt trotzdem Seiten 1–2 und ist beidseitig.
    const single = price({ ...cover, pages: 10, coverFromMainFile: 'front' })
    expect(amount(single, 'print')).toBe(8 * 10)
    expect(amount(single, 'cover_print')).toBe(2 * 10)
  })
})
