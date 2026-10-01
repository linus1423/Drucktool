// Was beim Absenden eines Auftrags festgeschrieben wird: Auswahl, Preis und die
// Katalogwerte, mit denen gerechnet wurde. Spätere Katalogänderungen ändern daran nichts.
import type { Pricing } from './catalog'
import {
  DELIVERY_LABELS,
  type CatalogBinding,
  type CatalogCoverColor,
  type CatalogPaper,
  type OrderSpec,
  type ResolvedOrder,
} from './order'
import type { PriceResult } from './pricing'

export type OrderSnapshot = {
  version: 1
  spec: OrderSpec
  price: PriceResult
  format: { id: string; label: string; kind: string; widthMm: number; heightMm: number }
  binding: CatalogBinding
  paper: CatalogPaper
  coverPaper: CatalogPaper | null
  coverColor: CatalogCoverColor | null
  coverBackColor: CatalogCoverColor | null
  pricing: Pricing
}

export function buildSnapshot(spec: OrderSpec, price: PriceResult, order: ResolvedOrder, pricing: Pricing): OrderSnapshot {
  return {
    version: 1,
    spec,
    price,
    format: { id: order.format.id, label: order.format.label, kind: order.format.kind, ...order.size },
    binding: order.binding,
    paper: order.paper,
    coverPaper: order.coverPaper,
    coverColor: order.coverColor,
    coverBackColor: order.coverBackColor,
    pricing,
  }
}

const paperLabel = (p: CatalogPaper) => `${p.name} ${p.grammage} g/m²`

/** Lesbare Zusammenfassung für Detailseite und E-Mails. */
export function describeOrder(s: Omit<OrderSnapshot, 'pricing' | 'price'>): [label: string, value: string][] {
  const rows: [string, string][] = []
  const { spec } = s
  rows.push([
    'Format',
    s.format.kind === 'custom' ? `${s.format.label} ${s.format.widthMm} × ${s.format.heightMm} mm` : s.format.label,
  ])
  rows.push(['Bindung', s.binding.label])
  rows.push(['Seiten', `${spec.pages} ${spec.pages === 1 ? 'Seite' : 'Seiten'}, ${spec.duplex ? 'doppelseitig' : 'einseitig'}`])
  rows.push(['Papier', paperLabel(s.paper)])
  if (s.coverPaper)
    rows.push(['Deckblatt', `${paperLabel(s.coverPaper)}, ${spec.coverPages === 2 ? 'vorne und hinten' : 'vorne'}`])
  if (s.coverColor || s.coverBackColor) {
    const front = s.coverColor?.name ?? 'Standard'
    const back = s.coverBackColor?.name ?? front
    rows.push(['Coverfarbe', front === back ? front : `vorne ${front}, hinten ${back}`])
  }
  if (spec.borderless) rows.push(['Randlos', 'ja'])
  rows.push(['Exemplare', String(spec.copies)])
  rows.push(['Lieferung', DELIVERY_LABELS[spec.delivery]])
  return rows
}
