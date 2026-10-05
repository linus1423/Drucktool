import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import {
  DEFAULT_COLORS,
  DEFAULT_DESIGN,
  colorTokens,
  contrast,
  designSchema,
  detectImageType,
  legalHref,
  pageTitle,
  parseDesign,
  parseSimpleText,
  type Design,
} from '~/lib/design'
import { DEFAULT_MAIL_LAYOUT, defaultTemplate, renderMail } from '~/lib/mail-templates'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const enc = (s: string) => new TextEncoder().encode(s)

describe('Design (Issue #186)', () => {
  it('fällt ohne oder bei kaputter Einstellung auf das heutige Aussehen zurück', () => {
    expect(parseDesign(undefined)).toEqual(DEFAULT_DESIGN)
    const parsed = parseDesign({ siteName: 'FSMB', colors: { primary: 'rot' } })
    expect(parsed.siteName).toBe('FSMB')
    expect(parsed.colors).toEqual(DEFAULT_COLORS)
    expect(pageTitle('Aufträge', parsed)).toBe('Aufträge · FSMB')
    expect(pageTitle('Aufträge', DEFAULT_DESIGN)).toBe('Aufträge · Drucktool')
  })

  it('lässt nur Hex-Farben und sichere Links zu', () => {
    const base: Design = { ...DEFAULT_DESIGN }
    expect(designSchema.safeParse({ ...base, colors: { ...DEFAULT_COLORS, primary: 'red' } }).success).toBe(false)
    expect(designSchema.parse({ ...base, colors: { ...DEFAULT_COLORS, primary: '#AABBCC' } }).colors.primary).toBe('#aabbcc')
    const link = (url: string) => designSchema.safeParse({ ...base, footerLinks: [{ label: 'Kontakt', url }] }).success
    expect(link('https://fsmb.de/kontakt')).toBe(true)
    expect(link('mailto:druckerei@fsmb.de')).toBe(true)
    expect(link('javascript:alert(1)')).toBe(false)
    const imprint = (v: Design['imprint']) => designSchema.safeParse({ ...base, imprint: v }).success
    expect(imprint({ mode: 'url', url: '', text: '' })).toBe(false)
    expect(imprint({ mode: 'text', url: '', text: '  ' })).toBe(false)
    expect(imprint({ mode: 'text', url: '', text: '# Impressum' })).toBe(true)
  })

  it('wählt Text- und Akzentfarben immer mit mindestens 4,5:1 Kontrast', () => {
    const samples = ['#000000', '#ffffff', '#777777', '#0f172a', '#ffeb3b', '#e11d48', '#22c55e', '#3b82f6', '#808080', '#0ea5e9']
    const failures: string[] = []
    for (const primary of samples) {
      for (const accent of samples) {
        const t = colorTokens({ primary, accent, header: primary })
        if (contrast(t.primaryFg, t.primary) < 4.5) failures.push(`Text auf ${primary}`)
        if (contrast(t.headerFg, t.header) < 4.5) failures.push(`Kopfzeile ${primary}`)
        if (contrast(t.accentStrong, t.accentSoft) < 4.5) failures.push(`Akzent ${accent} auf hell`)
        if (contrast(t.accentStrong, '#ffffff') < 4.5) failures.push(`Akzent ${accent} auf Weiß`)
      }
    }
    expect(failures).toEqual([])
    // Standard wie vorher: weiße Schrift auf Schiefergrau, dunkle Schrift in der weißen Kopfzeile.
    const d = colorTokens(DEFAULT_COLORS)
    expect(d.primaryFg).toBe('#ffffff')
    expect(d.headerFg).toBe('#0f172a')
  })

  it('erkennt Bildformate am Inhalt', () => {
    expect(detectImageType(PNG)).toBe('image/png')
    expect(detectImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(detectImageType(enc('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(detectImageType(enc('<?xml version="1.0"?>\n<!-- Logo -->\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(
      'image/svg+xml',
    )
    expect(detectImageType(enc('<html><svg></svg></html>'))).toBeNull()
    expect(detectImageType(enc('%PDF-1.7'))).toBeNull()
  })

  it('zerlegt Impressumstexte in Überschriften, Absätze, Listen und sichere Links', () => {
    const nodes = parseSimpleText(
      '# Impressum\n\nFachschaft\nBoltzmannstr. 15\n\n- [Kontakt](mailto:a@b.de)\n- https://fsmb.de\n\n[böse](javascript:alert(1))',
    )
    expect(nodes[0]).toEqual({ kind: 'h2', parts: [{ text: 'Impressum' }] })
    expect(nodes[1]).toEqual({ kind: 'p', parts: [{ text: 'Fachschaft\nBoltzmannstr. 15' }] })
    expect(nodes[2]).toEqual({
      kind: 'ul',
      items: [[{ text: 'Kontakt', href: 'mailto:a@b.de' }], [{ text: 'https://fsmb.de', href: 'https://fsmb.de' }]],
    })
    expect(nodes[3]).toEqual({ kind: 'p', parts: [{ text: '[böse](javascript:alert(1))' }] })
  })

  it('nimmt für Impressum und Datenschutz ohne Einstellung den Link aus der Serverkonfiguration', () => {
    expect(legalHref({ mode: 'none', url: '', text: '' }, '/impressum', 'https://env.example/impressum')).toBe(
      'https://env.example/impressum',
    )
    expect(legalHref({ mode: 'none', url: '', text: '' }, '/impressum', '')).toBeNull()
    expect(legalHref({ mode: 'url', url: 'https://a.example', text: '' }, '/impressum', 'https://env')).toBe('https://a.example')
    expect(legalHref({ mode: 'text', url: '', text: 'x' }, '/impressum', 'https://env')).toBe('/impressum')
  })

  it('bringt Logo, Primärfarbe und Links in die Mail (Issue #191)', () => {
    const brand = {
      siteName: 'FSMB',
      logoUrl: 'https://druck.example/api/design/logo?v=1',
      primary: '#e11d48',
      primaryFg: '#ffffff',
      links: [{ label: 'Impressum', href: 'https://druck.example/impressum' }],
    }
    const layout = { ...DEFAULT_MAIL_LAYOUT, showLegalLinks: true }
    const mail = renderMail(defaultTemplate('registration_approved'), { name: 'Erika', link: 'https://x.example' }, layout, brand)
    expect(mail.html).toContain('<img src="https://druck.example/api/design/logo?v=1" alt="FSMB"')
    expect(mail.html).toContain('background:#e11d48;color:#ffffff')
    expect(mail.html).toContain('href="https://druck.example/impressum"')
    expect(mail.text).toContain('Impressum: https://druck.example/impressum')
    const plain = renderMail(defaultTemplate('registration_approved'), { name: 'Erika', link: 'https://x.example' })
    expect(plain.html).not.toContain('<img')
    expect(plain.html).toContain('background:#0f172a;color:#ffffff')
    const noLogo = renderMail(defaultTemplate('registration_approved'), { name: 'E' }, { ...layout, showLogo: false }, brand)
    expect(noLogo.html).not.toContain('<img')
  })
})

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

describe.skipIf(!url)('Design-Seite (Integration)', async () => {
  const { getDb, schema } = await import('~/server/db/client.server')
  const designAdmin = await import('~/server/design/design-admin.server')
  const design = await import('~/server/design/design.server')
  const mail = await import('~/server/mail/mail-templates.server')
  type Actor = { id: string; role: 'admin' | 'staff' }
  let adminUser: Actor
  let staffUser: Actor
  const keys = ['design', 'design_logo', 'design_favicon', 'mail_layout']

  async function user(role: 'admin' | 'staff') {
    const email = `design-${role}-${Date.now()}@test`
    const [row] = await getDb().insert(schema.users).values({ email, lastName: role, role, status: 'active' }).returning()
    return { id: row!.id, role }
  }

  beforeAll(async () => {
    await getDb().delete(schema.settings).where(inArray(schema.settings.key, keys))
    adminUser = await user('admin')
    staffUser = await user('staff')
  })

  afterAll(async () => {
    await getDb().delete(schema.settings).where(inArray(schema.settings.key, keys))
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  it('zeigt ohne Einstellung das heutige Aussehen', async () => {
    const pub = await design.getPublicDesign()
    expect(pub.siteName).toBe('Drucktool')
    expect(pub.logoUrl).toBeNull()
    expect(pub.cssVariables['--color-primary']).toBe('#0f172a')
    expect((await mail.getMailLayout()).header).toBe('Drucktool')
  })

  it('speichert das Design nur für Admins und protokolliert die geänderten Teile', async () => {
    const next: Design = {
      ...DEFAULT_DESIGN,
      siteName: 'Fachschaftsdruckerei',
      colors: { ...DEFAULT_COLORS, primary: '#e11d48' },
      imprint: { mode: 'text', url: '', text: '# Impressum\nFSMB' },
      footerLinks: [{ label: 'Kontakt', url: 'mailto:druck@example.com' }],
    }
    await expect(designAdmin.saveDesign(staffUser, next)).rejects.toThrow('Keine Berechtigung')
    await designAdmin.saveDesign(adminUser, next)

    const pub = await design.getPublicDesign()
    expect(pub.siteName).toBe('Fachschaftsdruckerei')
    expect(pub.cssVariables['--color-primary']).toBe('#e11d48')
    expect(pub.footer.imprintHref).toBe('/impressum')
    expect(pub.footer.links).toEqual([{ label: 'Kontakt', url: 'mailto:druck@example.com' }])
    expect(await design.getLegalText('imprint')).toBe('# Impressum\nFSMB')
    expect(await design.getLegalText('privacy')).toBeNull()

    const [entry] = await getDb()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'design.updated'))
      .orderBy(schema.auditLog.createdAt)
    expect(entry?.data).toMatchObject({ changed: ['Name', 'Farben', 'Impressum', 'Links'] })

    // Ohne eigene Kopfzeile im Mail-Layout gilt der neue Name auch in Mails.
    expect((await mail.getMailLayout()).header).toBe('Fachschaftsdruckerei')
    const brand = await mail.getMailBrand()
    expect(brand.primary).toBe('#e11d48')
    expect(brand.links.map((l) => l.label)).toEqual(['Impressum', 'Kontakt'])
    expect(brand.links[0]!.href).toMatch(/^https?:\/\/.+\/impressum$/)
  })

  it('nimmt Logos nur als Bild an und liefert sie mit neuer Version aus', async () => {
    const asBase64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
    await expect(designAdmin.saveLogo(adminUser, 'logo', asBase64(enc('%PDF-1.7')))).rejects.toThrow('PNG, JPEG, WebP oder SVG')
    await expect(designAdmin.saveLogo(adminUser, 'logo', asBase64(new Uint8Array(600 * 1024)))).rejects.toThrow('zu groß')
    await expect(designAdmin.saveLogo(staffUser, 'logo', asBase64(PNG))).rejects.toThrow('Keine Berechtigung')

    await designAdmin.saveLogo(adminUser, 'logo', asBase64(PNG))
    const logo = await design.getLogo('logo')
    expect(logo?.type).toBe('image/png')
    expect(Buffer.compare(logo!.bytes, Buffer.from(PNG))).toBe(0)
    const pub = await design.getPublicDesign()
    expect(pub.logoUrl).toMatch(/^\/api\/design\/logo\?v=\d+$/)
    expect((await mail.getMailBrand()).logoUrl).toMatch(/^https?:\/\/.+\/api\/design\/logo\?v=\d+$/)

    await designAdmin.removeLogo(adminUser, 'logo')
    expect(await design.getLogo('logo')).toBeNull()
    expect((await design.getPublicDesign()).logoUrl).toBeNull()
    const actions = await getDb()
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(inArray(schema.auditLog.action, ['design.logo_updated', 'design.logo_removed']))
    expect(actions.map((a) => a.action).sort()).toEqual(['design.logo_removed', 'design.logo_updated'])
  })
})
