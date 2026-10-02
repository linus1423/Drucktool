// Übergabe fertiger Aufträge an Lexware financial office (Issue #53). Rechnungen entstehen in Lexware; das Drucktool
// liefert die Aufträge im Format openTRANS 1.0, das die Standard-Shopschnittstelle von Lexware importiert. Lexware legt
// daraus Rechnungen an und neue Kunden aus der Rechnungsadresse. Jede Position braucht einen Artikel, den es in Lexware
// schon gibt (LEXWARE_ARTICLE_NUMBER).
import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm'
import type { StoredBillingAddress } from '~/lib/address'
import { formatRequestNumber } from '~/lib/format'
import { DELIVERY_LABELS, type DeliveryMethod } from '~/lib/order'
import { describeOrder, type OrderSnapshot } from '~/lib/snapshot'
import { getDb, schema } from '../db/client.server'

const { requests, users } = schema

export function lexwareConfig() {
  const article = process.env.LEXWARE_ARTICLE_NUMBER?.trim() || 'DRUCK'
  const rate = Number(process.env.LEXWARE_TAX_RATE ?? 19)
  return { article, taxRate: Number.isFinite(rate) && rate >= 0 && rate < 100 ? rate : 19 }
}

export type LexwareOrder = {
  number: number
  title: string
  completedAt: Date
  totalCents: number
  deliveryCents: number
  deliveryMethod: DeliveryMethod
  email: string
  billing: StoredBillingAddress
  details: [string, string][]
}

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }

/** Text für XML-Elemente; Steuerzeichen außer Zeilenumbruch und Tab sind in XML 1.0 nicht erlaubt. */
export function xmlText(value: string) {
  let clean = ''
  for (const ch of value) {
    const code = ch.codePointAt(0)!
    const allowed = code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code !== 0xfffe && code !== 0xffff)
    if (allowed) clean += ch
  }
  return clean.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]!)
}

const amount = (cents: number) => (cents / 100).toFixed(2)
const el = (name: string, value: string, attrs = '') => `<${name}${attrs}>${xmlText(value)}</${name}>`

/** Datum mit Zeitzone wie in openTRANS verlangt, z. B. 2026-10-02T11:50:26+02:00. */
export function isoWithOffset(date: Date, timeZone = 'Europe/Berlin') {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  )
  const local = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!)
  const offset = Math.round((local - Math.floor(date.getTime() / 1000) * 1000) / 60000)
  const sign = offset < 0 ? '-' : '+'
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')
  const mm = String(Math.abs(offset) % 60).padStart(2, '0')
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${hh}:${mm}`
}

function orderXml(o: LexwareOrder, config: ReturnType<typeof lexwareConfig>, generatedAt: Date) {
  const b = o.billing
  // Lexware: NAME = Firma, NAME2 = Nachname, NAME3 = Vorname.
  const [first, last] = 'name' in b ? ['', b.name] : [b.firstName, b.lastName]
  const tax = (config.taxRate / 100).toFixed(2)
  const printCents = o.totalCents - o.deliveryCents
  const details = o.details.map(([label, value]) => `${label}: ${value}`).join('\n')
  const remarks = [
    el('REMARK', `Drucktool ${formatRequestNumber(o.number)}: ${o.title}`, ' type="order"'),
    o.deliveryMethod !== 'pickup' ? el('REMARK', DELIVERY_LABELS[o.deliveryMethod], ' type="delivery_method"') : '',
    o.deliveryCents ? el('REMARK', amount(o.deliveryCents), ' type="shipping_fee"') : '',
  ].filter(Boolean)
  // Aufbau wie in der Lexware-Spezifikation „Import von Bestellungen im openTRANS-Format“. Zahlungsart und
  // Lieferadresse bleiben weg: Lexware nimmt dann die Vorgaben am Kunden, Hauspost hat keine Postanschrift.
  return `<ORDER xmlns="http://www.opentrans.org/XMLSchema/1.0" version="1.0" type="standard">
<ORDER_HEADER>
<CONTROL_INFO>
${el('GENERATOR_INFO', 'Drucktool')}
${el('GENERATION_DATE', isoWithOffset(generatedAt))}
</CONTROL_INFO>
<ORDER_INFO>
${el('ORDER_ID', String(o.number))}
${el('ORDER_DATE', isoWithOffset(o.completedAt))}
<ORDER_PARTIES>
<INVOICE_PARTY>
<PARTY>
${el('PARTY_ID', o.email, ' type="buyer_specific"')}
<ADDRESS>
${el('NAME', b.organisation ?? '')}
${el('NAME2', last)}
${el('NAME3', first)}
${el('STREET', b.street)}
${el('ZIP', b.zip)}
${el('CITY', b.city)}
${el('COUNTRY', b.country?.trim() || 'Deutschland')}
${el('EMAIL', o.email)}
</ADDRESS>
</PARTY>
</INVOICE_PARTY>
</ORDER_PARTIES>
${remarks.join('\n')}
${el('PRICE_CURRENCY', '978')}
</ORDER_INFO>
</ORDER_HEADER>
<ORDER_ITEM_LIST>
<ORDER_ITEM>
${el('LINE_ITEM_ID', '1')}
<ARTICLE_ID>
${el('SUPPLIER_AID', config.article)}
${el('DESCRIPTION_SHORT', `${formatRequestNumber(o.number)} ${o.title}`.slice(0, 80))}
${el('DESCRIPTION_LONG', details)}
</ARTICLE_ID>
${el('QUANTITY', '1')}
<ARTICLE_PRICE type="gros_list">
${el('PRICE_AMOUNT', amount(printCents))}
${el('PRICE_LINE_AMOUNT', amount(printCents))}
${el('TAX', tax)}
</ARTICLE_PRICE>
</ORDER_ITEM>
</ORDER_ITEM_LIST>
<ORDER_SUMMARY>
${el('TOTAL_ITEM_NUM', '1')}
${el('TOTAL_AMOUNT', amount(o.totalCents))}
</ORDER_SUMMARY>
</ORDER>`
}

/** Datei für den Import in Lexware mit beliebig vielen Aufträgen (ORDER_LIST ist die Lexware-Erweiterung dafür). */
export function lexwareXml(orders: LexwareOrder[], config = lexwareConfig(), generatedAt = new Date()) {
  const body = orders.map((o) => orderXml(o, config, generatedAt)).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ORDER_LIST>\n${body}\n</ORDER_LIST>\n`
}

export class LexwareExportError extends Error {}

type Row = {
  id: string
  number: number
  title: string
  status: string
  statusChangedAt: Date
  totalCents: number | null
  order: OrderSnapshot | null
  deliveryMethod: DeliveryMethod
  billingAddress: StoredBillingAddress | null
  email: string
}

function toLexwareOrder(r: Row): LexwareOrder {
  if (r.totalCents == null) throw new LexwareExportError(`Auftrag ${formatRequestNumber(r.number)} hat keinen Preis.`)
  if (!r.billingAddress) throw new LexwareExportError(`Auftrag ${formatRequestNumber(r.number)} hat keine Rechnungsadresse.`)
  return {
    number: r.number,
    title: r.title,
    completedAt: r.statusChangedAt,
    totalCents: r.totalCents,
    deliveryCents: Math.min(r.order?.price.deliveryCents ?? 0, r.totalCents),
    deliveryMethod: r.deliveryMethod,
    email: r.email,
    billing: r.billingAddress,
    details: r.order ? describeOrder(r.order) : [],
  }
}

const selection = {
  id: requests.id,
  number: requests.number,
  title: requests.title,
  status: requests.status,
  statusChangedAt: requests.statusChangedAt,
  totalCents: requests.totalCents,
  order: requests.order,
  deliveryMethod: requests.deliveryMethod,
  billingAddress: requests.billingAddress,
  email: users.email,
}

/** Fertige Aufträge, die noch nicht an Lexware übergeben wurden. */
export async function pendingLexwareCount() {
  const [row] = await getDb()
    .select({ count: count() })
    .from(requests)
    .where(and(eq(requests.status, 'completed'), isNull(requests.invoiceExportedAt)))
  return row?.count ?? 0
}

/**
 * Erstellt die Importdatei und merkt sich die enthaltenen Aufträge als übergeben. Ohne ids: alle fertigen, noch nicht
 * übergebenen Aufträge. Mit ids: genau diese (auch erneut), solange sie fertig sind.
 */
export async function exportForLexware(actorId: string, ids?: string[]) {
  return getDb().transaction(async (tx) => {
    const where = ids
      ? and(inArray(requests.id, ids), eq(requests.status, 'completed'))
      : and(eq(requests.status, 'completed'), isNull(requests.invoiceExportedAt))
    const rows = await tx
      .select(selection)
      .from(requests)
      .innerJoin(users, eq(users.id, requests.createdById))
      .where(where)
      .orderBy(asc(requests.number))
      .for('update', { of: requests })
    if (ids && rows.length !== new Set(ids).size)
      throw new LexwareExportError('Nur fertige Aufträge können an Lexware übergeben werden.')
    const orders = rows.map(toLexwareOrder)
    if (rows.length) {
      await tx
        .update(requests)
        .set({ invoiceExportedAt: new Date(), invoiceExportedById: actorId })
        .where(
          inArray(
            requests.id,
            rows.map((r) => r.id),
          ),
        )
    }
    return { count: rows.length, numbers: rows.map((r) => r.number), xml: lexwareXml(orders) }
  })
}
