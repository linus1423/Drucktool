import { z } from 'zod'

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Bitte eine gültige E-Mail-Adresse angeben'))

export const passwordSchema = z
  .string()
  .min(10, 'Das Passwort muss mindestens 10 Zeichen lang sein')
  .max(200, 'Das Passwort ist zu lang')

export const requiredText = (label: string, max = 200) =>
  z.string().trim().min(1, `${label} ist erforderlich`).max(max, `${label} ist zu lang`)

const optionalText = (max = 200) => z.string().trim().max(max)

/** Vor- und Nachname einer Person. Der Vorname darf für Funktionskonten (z. B. „Poststelle“) leer bleiben. */
export const personNameFields = {
  firstName: optionalText(),
  lastName: requiredText('Nachname'),
}

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Bitte Passwort eingeben'),
})

export const organisationSchema = z.object({
  name: requiredText('Name'),
  email: z.union([z.literal(''), emailSchema]),
  phone: optionalText(50),
  street: optionalText(),
  zip: optionalText(20),
  city: optionalText(),
  country: z.string().trim().min(2).max(2),
  vatId: optionalText(50),
  status: z.enum(['pending', 'active', 'disabled']),
})

export const requestInputSchema = z.object({
  title: requiredText('Titel'),
  description: z.string().trim().max(10_000, 'Die Beschreibung ist zu lang'),
  quantity: z.number().int().positive('Die Auflage muss größer als 0 sein').max(10_000_000).nullable(),
  desiredDate: z.iso.date('Bitte ein gültiges Datum angeben').nullable(),
})
