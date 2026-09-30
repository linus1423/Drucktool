import * as client from 'openid-client'
import { eq } from 'drizzle-orm'
import { deleteCookie, getCookie, setCookie } from '@tanstack/react-start/server'
import { getDb, schema } from '../db/client.server'
import { getOidcClient, getOidcSettings } from './oidc.server'
import { resolveOidcUser } from './oidc-users.server'
import { assertRateLimit } from './rate-limit.server'
import { createSession, destroyCurrentSession } from './session.server'

const FLOW_COOKIE = 'drucktool_oidc'

type PendingLogin = { state: string; nonce: string; verifier: string; redirect: string }

function secure() {
  if (process.env.COOKIE_SECURE) return process.env.COOKIE_SECURE !== 'false'
  return process.env.NODE_ENV === 'production'
}

function redirectTo(location: string) {
  return new Response(null, { status: 302, headers: { Location: location } })
}

function loginError(message: string) {
  return redirectTo(`/login?fehler=${encodeURIComponent(message)}`)
}

/** Nur relative Ziele innerhalb der Anwendung zulassen (kein Open Redirect). */
export function safeRedirect(target: string | null | undefined) {
  return target && target.startsWith('/') && !target.startsWith('//') && !target.startsWith('/\\') ? target : '/anfragen'
}

/** Leitet zum Anbieter weiter. State, Nonce und PKCE-Verifier landen in einem kurzlebigen Cookie. */
export async function startOidcLogin(request: Request) {
  const settings = getOidcSettings()
  if (!settings) return loginError('Die Anmeldung über OpenID Connect ist nicht eingerichtet.')
  let config: client.Configuration
  try {
    config = await getOidcClient(settings)
  } catch (error) {
    console.error('[oidc] Discovery fehlgeschlagen', error)
    return loginError('Der Anmeldedienst ist gerade nicht erreichbar. Bitte versuchen Sie es später erneut.')
  }

  const pending: PendingLogin = {
    state: client.randomState(),
    nonce: client.randomNonce(),
    verifier: client.randomPKCECodeVerifier(),
    redirect: safeRedirect(new URL(request.url).searchParams.get('redirect')),
  }
  setCookie(FLOW_COOKIE, Buffer.from(JSON.stringify(pending)).toString('base64url'), {
    httpOnly: true,
    secure: secure(),
    sameSite: 'lax',
    path: '/api/auth/oidc',
    maxAge: 600,
  })

  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: settings.redirectUri,
    scope: settings.scope,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: await client.calculatePKCECodeChallenge(pending.verifier),
    code_challenge_method: 'S256',
  })
  return redirectTo(url.href)
}

function readPending(): PendingLogin | null {
  const raw = getCookie(FLOW_COOKIE)
  if (!raw) return null
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<PendingLogin>
    if (parsed.state && parsed.nonce && parsed.verifier) {
      return { state: parsed.state, nonce: parsed.nonce, verifier: parsed.verifier, redirect: safeRedirect(parsed.redirect) }
    }
  } catch {
    // ungültiges Cookie, wie fehlendes behandeln
  }
  return null
}

/** Rückkehr vom Anbieter: Code einlösen, Benutzer zuordnen, Sitzung anlegen. */
export async function finishOidcLogin(request: Request) {
  const settings = getOidcSettings()
  if (!settings) return loginError('Die Anmeldung über OpenID Connect ist nicht eingerichtet.')
  assertRateLimit('oidc-callback', 30, 60_000)

  const pending = readPending()
  deleteCookie(FLOW_COOKIE, { path: '/api/auth/oidc' })
  if (!pending) return loginError('Die Anmeldung ist abgelaufen. Bitte versuchen Sie es erneut.')

  const incoming = new URL(request.url)
  if (incoming.searchParams.get('error')) {
    return loginError('Die Anmeldung wurde beim Anmeldedienst abgebrochen.')
  }

  // Die Callback-URL aus der Konfiguration verwenden, damit sie hinter einem Proxy zur redirect_uri passt.
  const callbackUrl = new URL(settings.redirectUri)
  callbackUrl.search = incoming.search

  let issuer: string
  let claims: client.IDToken
  try {
    const config = await getOidcClient(settings)
    const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: pending.verifier,
      expectedState: pending.state,
      expectedNonce: pending.nonce,
      idTokenExpected: true,
    })
    const idClaims = tokens.claims()
    if (!idClaims) throw new Error('Kein ID-Token erhalten')
    claims = idClaims
    issuer = config.serverMetadata().issuer
    // Viele Anbieter liefern die E-Mail-Adresse nur über den UserInfo-Endpunkt.
    if (claims.email === undefined && tokens.access_token) {
      const info = await client.fetchUserInfo(config, tokens.access_token, claims.sub)
      claims = { ...claims, email: info.email, email_verified: info.email_verified, name: claims.name ?? info.name }
    }
  } catch (error) {
    console.error('[oidc] Anmeldung fehlgeschlagen', error)
    return loginError('Die Anmeldung konnte nicht abgeschlossen werden. Bitte versuchen Sie es erneut.')
  }

  const result = await resolveOidcUser(issuer, claims, {
    policy: settings.newUsers,
    trustEmail: settings.trustEmail,
    roles: settings.roles,
  })
  if (result.kind === 'pending') return redirectTo('/login?hinweis=freigabe')
  if (result.kind === 'denied') return loginError(result.message)

  await destroyCurrentSession()
  await createSession(result.userId)
  await getDb().update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, result.userId))
  return redirectTo(pending.redirect)
}
