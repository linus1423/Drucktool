import { z } from 'zod'

const required = (label: string, max = 200) =>
  z.string().trim().min(1, `${label} ist erforderlich`).max(max, `${label} ist zu lang`)
const optional = (max = 200) => z.string().trim().max(max)

export const billingAddressSchema = z.object({
  name: required('Name'),
  organisation: optional(),
  street: required('Straße und Hausnummer'),
  zip: required('PLZ', 20),
  city: required('Ort'),
  country: optional(100),
})
export type BillingAddress = z.infer<typeof billingAddressSchema>

/** Adresse für die Hauspost, z. B. Lehrstuhl, Gebäude und Raum. */
export const deliveryAddressSchema = z.object({
  recipient: required('Empfänger'),
  department: optional(),
  building: optional(100),
  room: optional(100),
  note: optional(500),
})
export type DeliveryAddress = z.infer<typeof deliveryAddressSchema>

export const EMPTY_BILLING: BillingAddress = { name: '', organisation: '', street: '', zip: '', city: '', country: '' }
export const EMPTY_DELIVERY: DeliveryAddress = { recipient: '', department: '', building: '', room: '', note: '' }

export function formatBillingAddress(a: BillingAddress): string[] {
  return [a.name, a.organisation, a.street, `${a.zip} ${a.city}`.trim(), a.country].filter((l): l is string => !!l?.trim())
}

export function formatDeliveryAddress(a: DeliveryAddress): string[] {
  const place = [a.building && `Gebäude ${a.building}`, a.room && `Raum ${a.room}`].filter(Boolean).join(', ')
  return [a.recipient, a.department, place, a.note].filter((l): l is string => !!l?.trim())
}
