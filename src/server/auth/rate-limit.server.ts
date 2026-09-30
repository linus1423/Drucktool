import { getRequestIP } from '@tanstack/react-start/server'

// Einfacher In-Memory-Limiter (Sliding Window). Reicht für eine einzelne App-Instanz.
const buckets = new Map<string, number[]>()

export function assertRateLimit(key: string, max: number, windowMs: number) {
  const ip = getRequestIP({ xForwardedFor: process.env.TRUST_PROXY === 'true' }) ?? 'unknown'
  const bucketKey = `${key}:${ip}`
  const now = Date.now()
  const hits = (buckets.get(bucketKey) ?? []).filter((t) => now - t < windowMs)
  if (hits.length >= max) {
    throw new Error('Zu viele Versuche. Bitte warten Sie einen Moment.')
  }
  hits.push(now)
  buckets.set(bucketKey, hits)
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) if (v.every((t) => now - t >= windowMs)) buckets.delete(k)
  }
}
