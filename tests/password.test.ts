import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '~/server/auth/password.server'

describe('Passwort-Hashing', () => {
  it('prüft richtige und falsche Passwörter', async () => {
    const hash = await hashPassword('ein-sicheres-passwort')
    expect(hash.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword(hash, 'ein-sicheres-passwort')).toBe(true)
    expect(await verifyPassword(hash, 'falsch')).toBe(false)
    expect(await verifyPassword('kaputt', 'egal')).toBe(false)
  })
})
