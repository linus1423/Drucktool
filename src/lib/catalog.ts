import { z } from 'zod'

const cents = z.number().int('Bitte ganze Cent angeben').min(0).max(10_000_000)
const nullableCents = cents.nullable()

/** Preise, die nicht an einem Papier oder einer Bindung hängen (Lastenheft Abschnitt 6). */
export const pricingSchema = z.object({
  /** Farbdruck pro Image (Seite) in A4 bzw. A3. Kleinere Formate zählen als A4. */
  printA4Cents: cents,
  printA3Cents: cents,
  /** Mindestpreis pro Auftrag (ohne Lieferkosten). */
  minimumOrderCents: cents,
  /** Hauspost pro Auftrag; bei Plots gilt der Plot-Zuschlag. */
  housePostCents: cents,
  housePostPlotCents: cents,
})
export type Pricing = z.infer<typeof pricingSchema>

/** Pflegbare Hilfetexte, die nicht an einer einzelnen Option hängen. */
export const textsSchema = z.object({
  turnaround: z.string().trim().max(2000),
  plots: z.string().trim().max(2000),
})
export type CatalogTexts = z.infer<typeof textsSchema>

const helpText = z.string().trim().max(2000)
const label = z.string().trim().min(1, 'Bezeichnung ist erforderlich').max(100)

export const formatUpdateSchema = z.object({
  id: z.string().min(1).max(50),
  label,
  allowsDuplex: z.boolean(),
  available: z.boolean(),
  helpText,
  sortOrder: z.number().int(),
})

export const bindingUpdateSchema = z.object({
  id: z.string().min(1).max(50),
  label,
  priceCents: cents,
  priceUnit: z.enum(['copy', 'sheet']),
  setupFeeCents: cents,
  allowsDuplex: z.boolean(),
  allowsCover: z.boolean(),
  allowsSplitCover: z.boolean(),
  trimmed: z.boolean(),
  available: z.boolean(),
  helpText,
  sortOrder: z.number().int(),
})

export const paperSchema = z.object({
  id: z.uuid().optional(),
  name: label,
  grammage: z.number().int().min(1, 'Grammatur fehlt').max(2000),
  priceA3Cents: nullableCents,
  priceSra3Cents: nullableCents,
  priceA0Cents: nullableCents,
  priceA1Cents: nullableCents,
  priceA2Cents: nullableCents,
  forCover: z.boolean(),
  forInner: z.boolean(),
  forPlotter: z.boolean(),
  maxFormatId: z.string().max(50).nullable(),
  available: z.boolean(),
  helpText,
  sortOrder: z.number().int(),
})
export type PaperInput = z.infer<typeof paperSchema>

export const coverColorSchema = z.object({
  id: z.uuid().optional(),
  name: label,
  hex: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Farbe als #rrggbb angeben')
    .nullable(),
  transparent: z.boolean(),
  available: z.boolean(),
  sortOrder: z.number().int(),
})

export const BINDING_UNIT_LABELS = { copy: 'pro Exemplar', sheet: 'pro Blatt' } as const
