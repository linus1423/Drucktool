import * as client from 'openid-client'

/**
 * OpenID-Connect-Einstellungen aus der Umgebung. Ohne OIDC_ISSUER ist die
 * Anmeldung per OIDC abgeschaltet.
 */
export type NewUserPolicy = 'reject' | 'pending' | 'staff'

export type OidcSettings = {
  issuer: string
  clientId: string
  clientSecret: string | undefined
  displayName: string
  scope: string
  newUsers: NewUserPolicy
  /** E-Mail-Adressen auch ohne email_verified-Claim als bestätigt ansehen (z. B. Microsoft Entra ID). */
  trustEmail: boolean
  redirectUri: string
}

export function getOidcSettings(): OidcSettings | null {
  const issuer = process.env.OIDC_ISSUER?.trim()
  const clientId = process.env.OIDC_CLIENT_ID?.trim()
  if (!issuer || !clientId) return null
  const policy = process.env.OIDC_NEW_USERS ?? 'pending'
  if (policy !== 'reject' && policy !== 'pending' && policy !== 'staff') {
    throw new Error('OIDC_NEW_USERS muss "reject", "pending" oder "staff" sein')
  }
  const appUrl = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
  return {
    issuer,
    clientId,
    clientSecret: process.env.OIDC_CLIENT_SECRET || undefined,
    displayName: process.env.OIDC_DISPLAY_NAME || 'Single Sign-on',
    scope: process.env.OIDC_SCOPE || 'openid email profile',
    newUsers: policy,
    trustEmail: process.env.OIDC_TRUST_EMAIL === 'true',
    redirectUri: `${appUrl}/api/auth/oidc/callback`,
  }
}

let cached: { key: string; config: Promise<client.Configuration> } | undefined

/** Lädt die Konfiguration des Anbieters (Discovery) einmal und hält sie im Speicher. */
export function getOidcClient(settings: OidcSettings): Promise<client.Configuration> {
  const key = `${settings.issuer}|${settings.clientId}`
  if (cached?.key !== key) {
    const config = client
      .discovery(
        new URL(settings.issuer),
        settings.clientId,
        settings.clientSecret,
        undefined,
        // http-Issuer nur für lokale Tests zulassen.
        settings.issuer.startsWith('http://') ? { execute: [client.allowInsecureRequests] } : undefined,
      )
      .catch((error: unknown) => {
        cached = undefined
        throw error
      })
    cached = { key, config }
  }
  return cached.config
}
