import { describe, expect, it } from 'vitest'
import { REQUEST_STATUSES, TERMINAL_STATUSES, allowedTransitions, canTransition } from '~/lib/status'

describe('Status-Workflow', () => {
  it('erlaubt keinen Übergang aus Endzuständen', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(allowedTransitions(status, 'staff')).toEqual([])
      expect(allowedTransitions(status, 'customer')).toEqual([])
    }
  })

  it('lässt Kunden nur Rückfragen beantworten und vor der Bestätigung stornieren', () => {
    expect(canTransition('on_hold', 'submitted', 'customer')).toBe(true)
    expect(canTransition('submitted', 'cancelled', 'customer')).toBe(true)
    expect(canTransition('confirmed', 'cancelled', 'customer')).toBe(false)
    expect(canTransition('submitted', 'confirmed', 'customer')).toBe(false)
    expect(canTransition('confirmed', 'completed', 'customer')).toBe(false)
  })

  it('führt Aufträge über Bestätigt zu Fertig', () => {
    expect(canTransition('submitted', 'confirmed', 'staff')).toBe(true)
    expect(canTransition('submitted', 'completed', 'staff')).toBe(false)
    expect(canTransition('confirmed', 'completed', 'staff')).toBe(true)
    expect(canTransition('on_hold', 'confirmed', 'staff')).toBe(true)
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
