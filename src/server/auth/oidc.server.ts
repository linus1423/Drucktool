import * as client from 'openid-client'

/**
 * OpenID-Connect-Einstellungen aus der Umgebung. Es gibt zwei unabhängige Anbieter:
 * - staff (OIDC_*): Anmeldung für Mitarbeiter, z. B. Microsoft Entra ID. Ohne OIDC_ISSUER abgeschaltet.
 * - customer (CUSTOMER_OIDC_*): Anmeldung für Kunden, z. B. der Federated TUM Keycloak (Issue #60).
 *   Ohne CUSTOMER_OIDC_ISSUER abgeschaltet.
 */
export type OidcProvider = 'staff' | 'customer'

/** customer: unbekannte Benutzer werden direkt als aktive Kunden angelegt (wie beim Anmeldelink). */
export type NewUserPolicy = 'reject' | 'pending' | 'staff' | 'customer'

export type RoleMapping = { claim: string; adminValues: string[]; staffValues: string[] }

export type OidcSettings = {
  provider: OidcProvider
  issuer: string
  clientId: string
  clientSecret: string | undefined
  displayName: string
  scope: string
  newUsers: NewUserPolicy
  /** E-Mail-Adressen auch ohne email_verified-Claim als bestätigt ansehen (z. B. Microsoft Entra ID). */
  trustEmail: boolean
  /** Rollen aus Token-Claims, z. B. Entra-App-Rollen. null = Rollen werden im Tool gepflegt. */
  roles: RoleMapping | null
  /** Mitarbeiter und Admins dürfen sich nicht mit Passwort anmelden (Superadmin schon, als Notfallzugang). */
  enforceForStaff: boolean
  /** Nur Kundenkonten dürfen sich über diesen Anbieter anmelden. */
  customersOnly: boolean
  /** Pfad der Login- und Callback-Routen, z. B. /api/auth/oidc */
  basePath: string
  redirectUri: string
}

export function getOidcSettings(provider: OidcProvider = 'staff'): OidcSettings | null {
  return provider === 'customer' ? customerSettings() : staffSettings()
}

const appUrl = () => (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '')

function staffSettings(): OidcSettings | null {
  const issuer = process.env.OIDC_ISSUER?.trim()
  const clientId = process.env.OIDC_CLIENT_ID?.trim()
  if (!issuer || !clientId) return null
  const policy = process.env.OIDC_NEW_USERS ?? 'pending'
  if (policy !== 'reject' && policy !== 'pending' && policy !== 'staff') {
    throw new Error('OIDC_NEW_USERS muss "reject", "pending" oder "staff" sein')
  }
  return {
    provider: 'staff',
    issuer,
    clientId,
    clientSecret: process.env.OIDC_CLIENT_SECRET || undefined,
    displayName: process.env.OIDC_DISPLAY_NAME || 'Single Sign-on',
    scope: process.env.OIDC_SCOPE || 'openid email profile',
    newUsers: policy,
    trustEmail: process.env.OIDC_TRUST_EMAIL === 'true',
    roles: roleMappingFromEnv(),
    enforceForStaff: process.env.OIDC_ENFORCE_FOR_STAFF === 'true',
    customersOnly: false,
    basePath: '/api/auth/oidc',
    redirectUri: `${appUrl()}/api/auth/oidc/callback`,
  }
}

function customerSettings(): OidcSettings | null {
  const issuer = process.env.CUSTOMER_OIDC_ISSUER?.trim()
  const clientId = process.env.CUSTOMER_OIDC_CLIENT_ID?.trim()
  if (!issuer || !clientId) return null
  return {
    provider: 'customer',
    issuer,
    clientId,
    clientSecret: process.env.CUSTOMER_OIDC_CLIENT_SECRET || undefined,
    displayName: process.env.CUSTOMER_OIDC_DISPLAY_NAME || 'TUM-Kennung',
    scope: process.env.CUSTOMER_OIDC_SCOPE || 'openid email profile',
    newUsers: 'customer',
    trustEmail: process.env.CUSTOMER_OIDC_TRUST_EMAIL === 'true',
    // Rollen kommen nie vom Kunden-Anbieter, Mitarbeiter melden sich über ihren eigenen Anbieter oder mit Passwort an.
    roles: null,
    enforceForStaff: false,
    customersOnly: true,
    basePath: '/api/auth/kunden-sso',
    redirectUri: `${appUrl()}/api/auth/kunden-sso/callback`,
  }
}

function list(value: string | undefined) {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}

function roleMappingFromEnv(): RoleMapping | null {
  const adminValues = list(process.env.OIDC_ADMIN_ROLES)
  const staffValues = list(process.env.OIDC_STAFF_ROLES)
  if (adminValues.length === 0 && staffValues.length === 0) return null
  return { claim: process.env.OIDC_ROLE_CLAIM || 'roles', adminValues, staffValues }
}

const cache = new Map<string, Promise<client.Configuration>>()

/** Lädt die Konfiguration des Anbieters (Discovery) einmal und hält sie im Speicher. */
export function getOidcClient(settings: OidcSettings): Promise<client.Configuration> {
  const key = `${settings.issuer}|${settings.clientId}`
  let config = cache.get(key)
  if (!config) {
    config = client
      .discovery(
        new URL(settings.issuer),
        settings.clientId,
        settings.clientSecret,
        undefined,
        // http-Issuer nur für lokale Tests zulassen.
        settings.issuer.startsWith('http://') ? { execute: [client.allowInsecureRequests] } : undefined,
      )
      .catch((error: unknown) => {
        cache.delete(key)
        throw error
      })
    cache.set(key, config)
  }
  return config
}
