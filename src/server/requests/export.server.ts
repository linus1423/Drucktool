// CSV-Export der Auftragsliste (Issue #19): Semikolon-getrennt, UTF-8 mit BOM, damit Excel Umlaute erkennt.
import { isStaffRole } from '~/lib/roles'
import { DELIVERY_LABELS } from '~/lib/order'
import { INTERNAL_STATUS_LABELS, STATUS_LABELS } from '~/lib/status'
import { exportRequests, type ListFilter, type Principal } from './requests.server'

const dateTime = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' })

/**
 * Schützt vor CSV-Injection: Zellen, die eine Tabellenkalkulation als Formel lesen würde,
 * bekommen ein vorangestelltes Hochkomma.
 */
export function csvCell(value: string | number | null | undefined) {
  if (value === null || value === undefined) return ''
  let text = String(value)
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(header: string[], rows: (string | number | null | undefined)[][]) {
  return '\uFEFF' + [header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n'
}

const euro = (cents: number | null) => (cents == null ? null : (cents / 100).toFixed(2).replace('.', ','))

export async function requestsCsv(user: Principal, filter: ListFilter) {
  const staff = isStaffRole(user.role)
  const rows = await exportRequests(user, filter)
  const header = [
    'Nummer',
    'Titel',
    ...(staff ? ['Kunde', 'E-Mail'] : []),
    'Organisation',
    'Status',
    ...(staff ? ['Interner Status'] : []),
    'Exemplare',
    'Preis (EUR)',
    'Lieferung',
    ...(staff ? ['Zuständig'] : []),
    'Angelegt',
    'Zuletzt geändert',
  ]
  return toCsv(
    header,
    rows.map((r) => [
      r.number,
      r.title,
      ...(staff ? [r.creatorName, r.creatorEmail] : []),
      r.organisationName,
      STATUS_LABELS[r.status],
      ...(staff ? [r.internalStatus ? INTERNAL_STATUS_LABELS[r.internalStatus] : null] : []),
      r.quantity,
      euro(r.totalCents),
      DELIVERY_LABELS[r.deliveryMethod],
      ...(staff ? [r.assigneeName] : []),
      dateTime.format(r.createdAt),
      dateTime.format(r.updatedAt),
    ]),
  )
}
