import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

// scrypt aus node:crypto: keine nativen Abhängigkeiten, gut für das Docker-Image.
const N = 2 ** 15
const r = 8
const p = 1
const KEY_LENGTH = 64
const MAX_MEM = 64 * 1024 * 1024

function derive(password: string, salt: Buffer, n: number, rr: number, pp: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N: n, r: rr, p: pp, maxmem: MAX_MEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    )
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(password, salt, N, r, p)
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  const [algo, n, rr, pp, saltB64, keyB64] = hash.split('$')
  if (algo !== 'scrypt' || !n || !rr || !pp || !saltB64 || !keyB64) return false
  const expected = Buffer.from(keyB64, 'base64')
  const actual = await derive(password, Buffer.from(saltB64, 'base64'), Number(n), Number(rr), Number(pp))
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// Wird bei unbekannten E-Mail-Adressen geprüft, damit Login-Antwortzeiten nichts verraten.
let dummyHash: Promise<string> | undefined
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'))
  return dummyHash
}
