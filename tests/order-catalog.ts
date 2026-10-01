// Katalog wie im Seed (Migration 0005), für Unit-Tests ohne Datenbank.
import type { OrderCatalog, OrderSpec } from '~/lib/order'

const f = (id: string, kind: 'print' | 'plot' | 'custom', w: number | null, h: number | null, duplex = true) => ({
  id,
  label: id === 'custom' ? 'Sonderformat' : id,
  kind,
  widthMm: w,
  heightMm: h,
  allowsDuplex: duplex,
  available: true,
  helpText: '',
})

const b = (id: string, label: string, priceCents: number, extra: Partial<OrderCatalog['bindings'][number]> = {}) => ({
  id,
  label,
  priceCents,
  priceUnit: 'copy' as const,
  setupFeeCents: 0,
  allowsDuplex: true,
  allowsCover: false,
  allowsSplitCover: false,
  trimmed: false,
  available: true,
  helpText: '',
  ...extra,
})

export const PAPER = {
  standard: '00000000-0000-4000-8000-000000000001',
  thick: '00000000-0000-4000-8000-000000000002',
  card: '00000000-0000-4000-8000-000000000003',
  plot: '00000000-0000-4000-8000-000000000004',
  noSra3: '00000000-0000-4000-8000-000000000005',
}
export const COLOR = {
  white: '00000000-0000-4000-9000-000000000001',
  clear: '00000000-0000-4000-9000-000000000002',
  blue: '00000000-0000-4000-9000-000000000003',
}

const paper = (id: string, name: string, grammage: number, extra: Partial<OrderCatalog['papers'][number]>) => ({
  id,
  name,
  grammage,
  priceA3Cents: null,
  priceSra3Cents: null,
  priceA0Cents: null,
  priceA1Cents: null,
  priceA2Cents: null,
  forCover: false,
  forInner: false,
  forPlotter: false,
  maxFormatId: 'A3',
  available: true,
  helpText: '',
  ...extra,
})

const matrix: Record<string, string[]> = {
  A0: ['loose'],
  A1: ['loose'],
  A2: ['loose'],
  A3: ['loose', 'corner_staple', 'laminated'],
  A4: ['loose', 'corner_staple', 'plastic_comb', 'glue', 'glue_dissertation', 'saddle_stitch', 'tape', 'laminated'],
  A5: ['loose', 'corner_staple', 'glue', 'glue_dissertation', 'saddle_stitch', 'tape'],
  A6: ['loose'],
  custom: ['loose', 'corner_staple', 'glue', 'glue_dissertation', 'saddle_stitch', 'tape', 'laminated'],
}

export const CATALOG: OrderCatalog = {
  formats: [
    f('A0', 'plot', 841, 1189, false),
    f('A1', 'plot', 594, 841, false),
    f('A2', 'plot', 420, 594, false),
    f('A3', 'print', 297, 420),
    f('A4', 'print', 210, 297),
    f('A5', 'print', 148, 210),
    f('A6', 'print', 105, 148),
    f('custom', 'custom', null, null),
  ],
  bindings: [
    b('loose', 'Lose', 0),
    b('corner_staple', 'Eckheftung', 0),
    b('plastic_comb', 'Plastikkammbindung', 200, { allowsCover: true, allowsSplitCover: true }),
    b('glue', 'Leimbindung', 200, { setupFeeCents: 700, allowsCover: true, trimmed: true }),
    b('glue_dissertation', 'Leimbindung Dissertation', 500, { setupFeeCents: 700, allowsCover: true, trimmed: true }),
    b('saddle_stitch', 'Booklet mit Rückstichheftung', 100, { allowsCover: true }),
    b('tape', 'Klebestreifen bzw. Fälzelbindung', 200, { allowsCover: true, allowsSplitCover: true }),
    b('laminated', 'Laminiert', 100, { priceUnit: 'sheet' }),
  ],
  formatBindings: Object.entries(matrix).flatMap(([formatId, ids]) => ids.map((bindingId) => ({ formatId, bindingId }))),
  papers: [
    paper(PAPER.standard, 'Standardpapier', 80, { priceA3Cents: 2, priceSra3Cents: 3, forInner: true }),
    paper(PAPER.thick, 'Dickes Papier', 160, { priceA3Cents: 6, priceSra3Cents: 8, forInner: true, forCover: true }),
    paper(PAPER.card, 'Karton', 300, { priceA3Cents: 15, priceSra3Cents: 20, forCover: true }),
    paper(PAPER.plot, 'Plotterpapier', 90, {
      priceA0Cents: 1500,
      priceA1Cents: 1200,
      priceA2Cents: 900,
      forPlotter: true,
      maxFormatId: 'A0',
    }),
    paper(PAPER.noSra3, 'Recyclingpapier', 80, { priceA3Cents: 2, forInner: true }),
  ],
  coverColors: [
    { id: COLOR.white, name: 'Weiß', hex: '#ffffff', transparent: false, available: true },
    { id: COLOR.clear, name: 'Durchsichtig', hex: null, transparent: true, available: true },
    { id: COLOR.blue, name: 'Dunkelblau', hex: '#1e3a8a', transparent: false, available: true },
  ],
  // Wie im Beispiel aus Issue #83: dickes Papier in allen Farben, Karton nur in Weiß.
  paperCoverColors: [
    ...[COLOR.white, COLOR.clear, COLOR.blue].map((coverColorId) => ({ paperId: PAPER.thick, coverColorId })),
    { paperId: PAPER.card, coverColorId: COLOR.white },
  ],
  pricing: { printA4Cents: 10, printA3Cents: 20, minimumOrderCents: 100, housePostCents: 0, housePostPlotCents: 200 },
  texts: { turnaround: '', plots: '', terms: '' },
}

export function spec(overrides: Partial<OrderSpec> = {}): OrderSpec {
  return {
    formatId: 'A4',
    customWidthMm: null,
    customHeightMm: null,
    bindingId: 'loose',
    duplex: false,
    paperId: PAPER.standard,
    coverPaperId: null,
    coverPages: null,
    coverFromMainFile: false,
    coverColorId: null,
    coverBackColorId: null,
    borderless: false,
    copies: 1,
    pages: 1,
    delivery: 'pickup',
    ...overrides,
  }
}
