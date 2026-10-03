import { z } from 'zod'
import { displayName } from './name'

const required = (label: string, max = 200) =>
  z.string().trim().min(1, `${label} ist erforderlich`).max(max, `${label} ist zu lang`)
const optional = (max = 200) => z.string().trim().max(max)

export const billingAddressSchema = z.object({
  firstName: required('Vorname'),
  lastName: required('Nachname'),
  organisation: optional(),
  street: required('Straße und Hausnummer'),
  zip: required('PLZ', 20),
  city: required('Ort'),
  country: optional(100),
})
export type BillingAddress = z.infer<typeof billingAddressSchema>

/**
 * Rechnungsadresse, wie sie an älteren Aufträgen eingefroren ist: vor Migration 0015 gab es nur
 * ein gemeinsames Feld `name`. Solche Kopien werden nicht umgeschrieben, nur weiterhin angezeigt.
 */
export type LegacyBillingAddress = Omit<BillingAddress, 'firstName' | 'lastName'> & { name: string }
export type StoredBillingAddress = BillingAddress | LegacyBillingAddress

/** Name in der Rechnungsadresse, auch für alte Kopien mit nur einem Namensfeld. */
export function billingName(a: StoredBillingAddress): string {
  return 'name' in a ? a.name : displayName(a)
}

export const DELIVERY_PLACE_MISSING = 'Bitte Lehrstuhl/Einrichtung oder Gebäude angeben, damit die Hauspost Sie findet'

/**
 * Adresse für die Hauspost, z. B. Lehrstuhl, Gebäude und Raum. Nur mit dem Empfänger weiß die Hauspost nicht,
 * wohin (Issue #143), deshalb braucht es zusätzlich den Lehrstuhl oder das Gebäude.
 */
export const deliveryAddressSchema = z
  .object({
    recipient: required('Empfänger'),
    department: optional(),
    building: optional(100),
    room: optional(100),
    note: optional(500),
  })
  .refine((a) => !!a.department || !!a.building, { message: DELIVERY_PLACE_MISSING, path: ['department'] })
export type DeliveryAddress = z.infer<typeof deliveryAddressSchema>

export const EMPTY_BILLING: BillingAddress = {
  firstName: '',
  lastName: '',
  organisation: '',
  street: '',
  zip: '',
  city: '',
  country: '',
}
export const EMPTY_DELIVERY: DeliveryAddress = { recipient: '', department: '', building: '', room: '', note: '' }

export function formatBillingAddress(a: StoredBillingAddress): string[] {
  return [billingName(a), a.organisation, a.street, `${a.zip} ${a.city}`.trim(), a.country].filter(
    (l): l is string => !!l?.trim(),
  )
}

export function formatDeliveryAddress(a: DeliveryAddress): string[] {
  const place = [a.building && `Gebäude ${a.building}`, a.room && `Raum ${a.room}`].filter(Boolean).join(', ')
  return [a.recipient, a.department, place, a.note].filter((l): l is string => !!l?.trim())
}
