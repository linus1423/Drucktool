import { describe, expect, it } from 'vitest'
import { REQUEST_STATUSES, TERMINAL_STATUSES, allowedTransitions, canTransition } from '~/lib/status'

describe('Status-Workflow', () => {
  it('erlaubt keinen Übergang aus Endzuständen', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(allowedTransitions(status, 'staff')).toEqual([])
      expect(allowedTransitions(status, 'customer')).toEqual([])
    }
  })

  it('lässt Kunden ein Angebot annehmen oder ablehnen', () => {
    expect(canTransition('quoted', 'approved', 'customer')).toBe(true)
    expect(canTransition('quoted', 'cancelled', 'customer')).toBe(true)
  })

  it('lässt Kunden keine Produktionsschritte auslösen', () => {
    expect(canTransition('approved', 'printing', 'customer')).toBe(false)
    expect(canTransition('new', 'in_review', 'customer')).toBe(false)
    expect(canTransition('in_review', 'quoted', 'customer')).toBe(false)
  })

  it('verhindert Stornierungen, sobald gedruckt wird', () => {
    expect(canTransition('printing', 'cancelled', 'staff')).toBe(false)
    expect(canTransition('printing', 'cancelled', 'customer')).toBe(false)
  })

  it('führt nur zu bekannten Status', () => {
    for (const from of REQUEST_STATUSES) {
      for (const to of [...allowedTransitions(from, 'staff'), ...allowedTransitions(from, 'customer')]) {
        expect(REQUEST_STATUSES).toContain(to)
        expect(to).not.toBe(from)
      }
    }
  })
})
