// Änderungsvorschläge der Druckerei (Issue #50). Mitarbeiter schlagen neue Optionen oder einen
// neuen Preis vor; wirksam wird die Änderung erst, wenn der Kunde zustimmt.
import { formatDeliveryAddress, type DeliveryAddress } from './address'
import { formatMoney } from './format'
import type { PriceResult } from './pricing'
import { describeOrder, type OrderSnapshot } from './snapshot'

export type ChangeProposal = {
  order: OrderSnapshot
  totalCents: number
  deliveryAddress: DeliveryAddress | null
  /** Begründung für den Kunden. */
  reason: string
  proposedById: string
  proposedByName: string
  proposedAt: string
  /** Status, in den der Auftrag nach der Zustimmung zurückkehrt. */
  returnStatus: 'submitted' | 'confirmed'
}

/** Ersetzt den berechneten Preis durch einen manuell gesetzten; die Differenz wird als Korrektur ausgewiesen. */
export function applyPriceOverride(price: PriceResult, totalCents: number | null, reason: string): PriceResult {
  if (totalCents == null || totalCents === price.totalCents) return price
  const diff = totalCents - price.totalCents
  return {
    ...price,
    lines: [
      ...price.lines,
      { key: 'adjustment', label: 'Korrektur durch die Druckerei', detail: reason, amountCents: diff, group: 'print' },
    ],
    printCents: price.printCents + diff,
    totalCents,
  }
}

export type ComparedRow = { label: string; before: string; after: string; changed: boolean }

type Side = { order: Omit<OrderSnapshot, 'pricing'> | null; totalCents: number | null; deliveryAddress: DeliveryAddress | null }

/** Vorher/Nachher-Tabelle für Kunde und Mitarbeiter. */
export function compareOrders(before: Side, after: Side): ComparedRow[] {
  const rows = (s: Side) => {
    const map = new Map<string, string>(s.order ? describeOrder(s.order) : [])
    if (s.order?.spec.delivery === 'house_post' && s.deliveryAddress) {
      map.set('Lieferadresse', formatDeliveryAddress(s.deliveryAddress).join(', '))
    }
    map.set('Preis', s.totalCents != null ? formatMoney(s.totalCents) : '–')
    return map
  }
  const a = rows(before)
  const b = rows(after)
  const labels = [...new Set([...a.keys(), ...b.keys()])]
  return labels.map((label) => {
    const x = a.get(label) ?? '–'
    const y = b.get(label) ?? '–'
    return { label, before: x, after: y, changed: x !== y }
  })
}
