const dateFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeZone: 'Europe/Berlin' })
const dateTimeFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' })
const moneyFormat = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' })

export function formatDate(value: Date | string | null | undefined) {
  if (!value) return '–'
  const date = typeof value === 'string' ? new Date(value.length === 10 ? `${value}T12:00:00Z` : value) : value
  return dateFormat.format(date)
}

export function formatDateTime(value: Date | string | null | undefined) {
  if (!value) return '–'
  return dateTimeFormat.format(typeof value === 'string' ? new Date(value) : value)
}

export function formatMoney(cents: number | null | undefined) {
  if (cents === null || cents === undefined) return '–'
  return moneyFormat.format(cents / 100)
}

/** Wandelt "1.234,50" oder "1234.5" in Cent um. */
export function parseMoneyToCents(input: string): number | null {
  const normalized = input.trim().replace(/\s|€/g, '')
  if (!normalized) return null
  const decimal = normalized.includes(',') ? normalized.replace(/\./g, '').replace(',', '.') : normalized
  if (!/^\d+(\.\d{1,2})?$/.test(decimal)) return null
  return Math.round(Number(decimal) * 100)
}

export function formatRequestNumber(n: number) {
  return `#${n}`
}
