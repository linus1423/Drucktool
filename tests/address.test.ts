import { describe, expect, it } from 'vitest'
import { deliveryAddressSchema } from '~/lib/address'

describe('Hauspost-Adresse (Issue #143)', () => {
  const base = { recipient: 'Erika Muster', department: '', building: '', room: '', note: '' }

  it('reicht nicht mit nur dem Empfänger', () => {
    const result = deliveryAddressSchema.safeParse(base)
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['department'])
  })

  it('geht mit Lehrstuhl oder Gebäude', () => {
    expect(deliveryAddressSchema.safeParse({ ...base, department: 'Lehrstuhl für Drucktechnik' }).success).toBe(true)
    expect(deliveryAddressSchema.safeParse({ ...base, building: 'MW', room: '1001' }).success).toBe(true)
  })

  it('zählt Leerzeichen nicht als Angabe', () => {
    expect(deliveryAddressSchema.safeParse({ ...base, department: '   ' }).success).toBe(false)
  })
})
