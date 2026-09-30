import { describe, expect, it } from 'vitest'
import { parseMoneyToCents } from '~/lib/format'

describe('parseMoneyToCents', () => {
  it.each([
    ['249,90', 24990],
    ['1.234,5', 123450],
    ['1234.5', 123450],
    ['329 €', 32900],
    ['0', 0],
  ])('%s -> %d', (input, cents) => {
    expect(parseMoneyToCents(input)).toBe(cents)
  })

  it.each(['', 'abc', '12,345', '-5'])('lehnt %j ab', (input) => {
    expect(parseMoneyToCents(input)).toBeNull()
  })
})
