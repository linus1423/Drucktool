import { afterAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

describe.skipIf(!url)('OpenID Connect: Benutzerzuordnung (Integration)', async () => {
  const { getDb, schema } = await import('~/server/db/client.server')
  const { resolveOidcUser, roleFromClaims } = await import('~/server/auth/oidc-users.server')
  const { safeRedirect } = await import('~/server/auth/oidc-flow.server')
  const ISS = 'https://idp.test'
  const stamp = Date.now()
  const email = (name: string) => `${name}-${stamp}@oidc.test`

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  it('verknüpft ein bestehendes Konto über die bestätigte E-Mail-Adresse', async () => {
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: email('Staff'), name: 'Staff', role: 'staff', status: 'active' })
      .returning()
    const result = await resolveOidcUser(ISS, { sub: `s-${stamp}`, email: email('staff'), email_verified: true }, { policy: 'reject' })
    expect(result).toEqual({ kind: 'login', userId: user!.id })
    // Danach zählt die Verknüpfung, auch wenn sich die Adresse beim Anbieter ändert.
    const again = await resolveOidcUser(ISS, { sub: `s-${stamp}`, email: 'anders@oidc.test', email_verified: true }, { policy: 'reject' })
    expect(again).toEqual({ kind: 'login', userId: user!.id })
  })

  it('verknüpft nicht über unbestätigte Adressen', async () => {
    await getDb().insert(schema.users).values({ email: email('opfer'), name: 'Opfer', role: 'admin', status: 'active' })
    const result = await resolveOidcUser(ISS, { sub: `x-${stamp}`, email: email('opfer'), email_verified: false }, { policy: 'staff' })
    expect(result.kind).toBe('denied')
    const links = await getDb().select().from(schema.oidcAccounts).where(eq(schema.oidcAccounts.subject, `x-${stamp}`))
    expect(links).toHaveLength(0)
  })

  it('vertraut Adressen ohne email_verified nur, wenn es eingestellt ist', async () => {
    const claims = { sub: `t-${stamp}`, email: email('entra') }
    expect((await resolveOidcUser(ISS, claims, { policy: 'staff' })).kind).toBe('denied')
    expect((await resolveOidcUser(ISS, claims, { policy: 'staff', trustEmail: true })).kind).toBe('login')
  })

  it('legt unbekannte Benutzer je nach Einstellung an', async () => {
    expect(await resolveOidcUser(ISS, { sub: `r-${stamp}`, email: email('neu1'), email_verified: true }, { policy: 'reject' })).toMatchObject({
      kind: 'denied',
    })

    const pending = await resolveOidcUser(ISS, { sub: `p-${stamp}`, email: email('neu2'), email_verified: true, name: 'Neu Zwei' }, { policy: 'pending' })
    expect(pending).toEqual({ kind: 'pending' })
    const [p] = await getDb().select().from(schema.users).where(eq(schema.users.email, email('neu2')))
    expect(p).toMatchObject({ role: 'customer', status: 'pending', name: 'Neu Zwei', passwordHash: null })

    const staff = await resolveOidcUser(ISS, { sub: `st-${stamp}`, email: email('neu3'), email_verified: true }, { policy: 'staff' })
    expect(staff.kind).toBe('login')
    const [s] = await getDb().select().from(schema.users).where(eq(schema.users.email, email('neu3')))
    expect(s).toMatchObject({ role: 'staff', status: 'active' })
  })

  it('lässt deaktivierte Konten nicht herein', async () => {
    await getDb().insert(schema.users).values({ email: email('weg'), name: 'Weg', role: 'staff', status: 'disabled' })
    const result = await resolveOidcUser(ISS, { sub: `d-${stamp}`, email: email('weg'), email_verified: true }, { policy: 'staff' })
    expect(result.kind).toBe('denied')
  })

  it('liest Rollen aus Listen- und Text-Claims', () => {
    const mapping = { claim: 'roles', adminValues: ['Druck.Admin'], staffValues: ['Druck.Staff'] }
    expect(roleFromClaims({ sub: 'a', roles: ['Druck.Staff', 'Druck.Admin'] }, mapping)).toBe('admin')
    expect(roleFromClaims({ sub: 'a', roles: 'foo Druck.Staff' }, mapping)).toBe('staff')
    expect(roleFromClaims({ sub: 'a', roles: 'foo,bar' }, mapping)).toBeNull()
    expect(roleFromClaims({ sub: 'a' }, mapping)).toBeNull()
  })

  it('übernimmt Rollen vom Anbieter und entzieht sie wieder', async () => {
    const roles = { claim: 'roles', adminValues: ['Druck.Admin'], staffValues: ['Druck.Staff'] }
    const sub = `m-${stamp}`
    const base = { sub, email: email('mitarbeiter'), email_verified: true }

    // Unbekannter Benutzer mit Rolle wird trotz "reject" direkt als Mitarbeiter angelegt.
    const first = await resolveOidcUser(ISS, { ...base, roles: ['Druck.Staff'] }, { policy: 'reject', roles })
    expect(first.kind).toBe('login')
    const [u] = await getDb().select().from(schema.users).where(eq(schema.users.email, email('mitarbeiter')))
    expect(u).toMatchObject({ role: 'staff', status: 'active' })

    // Beförderung zum Admin beim nächsten Login.
    await resolveOidcUser(ISS, { ...base, roles: ['Druck.Admin'] }, { policy: 'reject', roles })
    const [promoted] = await getDb().select().from(schema.users).where(eq(schema.users.id, u!.id))
    expect(promoted!.role).toBe('admin')

    // Rolle entfernt: Anmeldung abgelehnt, laufende Sitzungen beendet.
    await getDb().insert(schema.sessions).values({ id: `h-${stamp}`, userId: u!.id, expiresAt: new Date(Date.now() + 60_000) })
    const denied = await resolveOidcUser(ISS, { ...base, roles: [] }, { policy: 'reject', roles })
    expect(denied.kind).toBe('denied')
    const left = await getDb().select().from(schema.sessions).where(eq(schema.sessions.userId, u!.id))
    expect(left).toHaveLength(0)
  })

  it('lässt den Superadmin bei der Rollenzuordnung unangetastet', async () => {
    const roles = { claim: 'roles', adminValues: ['Druck.Admin'], staffValues: ['Druck.Staff'] }
    const [su] = await getDb()
      .insert(schema.users)
      .values({ email: email('super'), name: 'Super', role: 'superadmin', status: 'active' })
      .returning()
    const result = await resolveOidcUser(ISS, { sub: `su-${stamp}`, email: email('super'), email_verified: true }, { policy: 'reject', roles })
    expect(result).toEqual({ kind: 'login', userId: su!.id })
    const [after] = await getDb().select().from(schema.users).where(eq(schema.users.id, su!.id))
    expect(after!.role).toBe('superadmin')
  })

  it('erlaubt nur relative Weiterleitungen', () => {
    expect(safeRedirect('/konto')).toBe('/konto')
    expect(safeRedirect('//evil.example')).toBe('/auftraege')
    expect(safeRedirect('/\\evil.example')).toBe('/auftraege')
    expect(safeRedirect('https://evil.example')).toBe('/auftraege')
    expect(safeRedirect(null)).toBe('/auftraege')
  })
})
