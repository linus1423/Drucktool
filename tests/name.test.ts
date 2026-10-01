import { describe, expect, it } from 'vitest'
import { billingName, formatBillingAddress, type LegacyBillingAddress } from '~/lib/address'
import { displayName, splitName } from '~/lib/name'
import { BILLING } from './fixtures'

describe('splitName', () => {
  it.each([
    ['Erika Muster', 'Erika', 'Muster'],
    ['Anna Maria  Muster', 'Anna Maria', 'Muster'],
    ['  Max Mustermann ', 'Max', 'Mustermann'],
    ['Superadmin', '', 'Superadmin'],
    ['', '', ''],
  ])('%j -> %j / %j', (full, firstName, lastName) => {
    expect(splitName(full)).toEqual({ firstName, lastName })
  })
})

describe('displayName', () => {
  it('setzt Vor- und Nachname zusammen und lässt leere Teile weg', () => {
    expect(displayName({ firstName: 'Erika', lastName: 'Muster' })).toBe('Erika Muster')
    expect(displayName({ firstName: '', lastName: 'Poststelle' })).toBe('Poststelle')
    expect(displayName({ firstName: ' Erika ', lastName: '' })).toBe('Erika')
  })
})

describe('Rechnungsadresse', () => {
  it('zeigt Vor- und Nachnamen in der ersten Zeile', () => {
    expect(formatBillingAddress(BILLING)).toEqual(['Erika Muster', 'Lehrstuhl für Drucktechnik', 'Boltzmannstraße 15', '85748 Garching'])
  })

  it('zeigt eingefrorene Kopien älterer Aufträge mit gemeinsamem Namensfeld weiter an', () => {
    const legacy: LegacyBillingAddress = { name: 'Dr. Erika Muster', organisation: '', street: 'Weg 1', zip: '1', city: 'Ort', country: '' }
    expect(billingName(legacy)).toBe('Dr. Erika Muster')
    expect(formatBillingAddress(legacy)).toEqual(['Dr. Erika Muster', 'Weg 1', '1 Ort'])
  })
})
