import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt } from 'drizzle-orm'
import { getCookie, getRequestHeader, getRequestIP, setCookie, deleteCookie } from '@tanstack/react-start/server'
import { getDb, schema } from '../db/client.server'
import type { UserRole, UserStatus } from '~/lib/roles'

const COOKIE_NAME = 'drucktool_session'
const SESSION_DAYS = 14
const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000

export type SessionUser = {
  id: string
  email: string
  name: string
  role: UserRole
  status: UserStatus
  organisationId: string | null
  organisationName: string | null
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function cookieSecure() {
  if (process.env.COOKIE_SECURE) return process.env.COOKIE_SECURE !== 'false'
  return process.env.NODE_ENV === 'production'
}

function writeCookie(token: string, expiresAt: Date) {
  setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  })
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000)
  await getDb()
    .insert(schema.sessions)
    .values({
      id: hashToken(token),
      userId,
      expiresAt,
      userAgent: getRequestHeader('user-agent')?.slice(0, 500) ?? null,
      ip: getRequestIP({ xForwardedFor: process.env.TRUST_PROXY === 'true' }) ?? null,
    })
  writeCookie(token, expiresAt)
}

export async function destroyCurrentSession() {
  const token = getCookie(COOKIE_NAME)
  if (token) {
    await getDb()
      .delete(schema.sessions)
      .where(eq(schema.sessions.id, hashToken(token)))
  }
  deleteCookie(COOKIE_NAME, { path: '/' })
}

export async function revokeUserSessions(userId: string) {
  await getDb().delete(schema.sessions).where(eq(schema.sessions.userId, userId))
}

/** Liefert den angemeldeten, aktiven Benutzer oder null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const token = getCookie(COOKIE_NAME)
  if (!token) return null
  const db = getDb()
  const id = hashToken(token)
  const [row] = await db
    .select({
      sessionExpiresAt: schema.sessions.expiresAt,
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      role: schema.users.role,
      status: schema.users.status,
      organisationId: schema.users.organisationId,
      organisationName: schema.organisations.name,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .leftJoin(schema.organisations, eq(schema.organisations.id, schema.users.organisationId))
    .where(and(eq(schema.sessions.id, id), gt(schema.sessions.expiresAt, new Date())))
    .limit(1)

  if (!row || row.status !== 'active') return null

  // Gleitende Verlängerung, damit aktive Nutzer angemeldet bleiben.
  if (row.sessionExpiresAt.getTime() - Date.now() < RENEW_BEFORE_MS) {
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000)
    await db.update(schema.sessions).set({ expiresAt }).where(eq(schema.sessions.id, id))
    writeCookie(token, expiresAt)
  }

  const { sessionExpiresAt: _, ...user } = row
  return user
}

/** Kennung der Sitzung dieses Requests (Hash des Cookies), oder null. */
export function currentSessionId(): string | null {
  const token = getCookie(COOKIE_NAME)
  return token ? hashToken(token) : null
}
