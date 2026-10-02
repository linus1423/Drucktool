import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { errorMessage } from '~/lib/errors'
import { customSizeFields, findFormat, orderSpecSchema } from '~/lib/order'
import { CATALOG, spec } from './order-catalog'

/** So kommt ein abgelehnter Validator einer Server-Funktion beim Client an: nur der Text des ZodError. */
function serverError(schema: z.ZodType, input: unknown) {
  const result = schema.safeParse(input)
  if (result.success) throw new Error('Eingabe ist gültig')
  return new Error(result.error.message)
}

describe('errorMessage', () => {
  it('zeigt bei Validierungsfehlern nur die Meldungen statt der JSON-Liste (Issue #117)', () => {
    const error = serverError(orderSpecSchema, spec({ formatId: 'custom', customWidthMm: 500, customHeightMm: 460 }))
    expect(error.message).toContain('"path"')
    expect(errorMessage(error)).toBe('Breite des Sonderformats: höchstens 450 mm. Höhe des Sonderformats: höchstens 450 mm.')
  })

  it('nennt das betroffene Feld', () => {
    const error = serverError(orderSpecSchema, spec({ formatId: 'custom', customWidthMm: 300, customHeightMm: 451 }))
    expect(errorMessage(error)).toBe('Höhe des Sonderformats: höchstens 450 mm.')
  })

  it('verarbeitet auch einen ZodError direkt und fasst doppelte Meldungen zusammen', () => {
    const schema = z.object({ a: z.string().min(1, 'Bitte etwas angeben'), b: z.string().min(1, 'Bitte etwas angeben') })
    const result = schema.safeParse({ a: '', b: '' })
    expect(errorMessage(result.error)).toBe('Bitte etwas angeben.')
  })

  it('lässt normale Meldungen unverändert', () => {
    expect(errorMessage(new Error('Der Preis hat sich geändert.'))).toBe('Der Preis hat sich geändert.')
    expect(errorMessage(new Error('[Hinweis] kein JSON'))).toBe('[Hinweis] kein JSON')
    expect(errorMessage(new Error('[1, 2]'))).toBe('[1, 2]')
  })

  it('hat eine Ersatzmeldung für Unbekanntes', () => {
    expect(errorMessage('kaputt')).toBe('Es ist ein unerwarteter Fehler aufgetreten.')
    expect(errorMessage(new Error(''))).toBe('Es ist ein unerwarteter Fehler aufgetreten.')
  })
})

describe('customSizeFields', () => {
  it('übernimmt die Maße nur beim Sonderformat', () => {
    expect(customSizeFields(findFormat(CATALOG, 'custom'), 100, 200)).toEqual({ customWidthMm: 100, customHeightMm: 200 })
  })

  it('verwirft ein ungültiges Sonderformat nach dem Wechsel zu einem anderen Format (Issue #117)', () => {
    const fields = customSizeFields(findFormat(CATALOG, 'A4'), 500, 500)
    expect(fields).toEqual({ customWidthMm: null, customHeightMm: null })
    expect(orderSpecSchema.safeParse(spec({ formatId: 'A4', ...fields })).success).toBe(true)
  })

  it('ohne Format gibt es keine Maße', () => {
    expect(customSizeFields(undefined, 100, 200)).toEqual({ customWidthMm: null, customHeightMm: null })
  })
})
