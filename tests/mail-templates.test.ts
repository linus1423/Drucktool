import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { blocksToHtml, defaultTemplate, renderMail, unknownPlaceholders, type StoredTemplate } from '~/lib/mail-templates'
import { commentMail, registrationRejectedMail } from '~/server/mail/templates'
import { fromWithName } from '~/server/mail/transport.server'

describe('E-Mail-Vorlagen rendern', () => {
  const blocks = (b: StoredTemplate['blocks']): StoredTemplate => ({
    subject: 'Hallo {{name}}',
    mode: 'blocks',
    blocks: b,
    html: '',
  })

  it('setzt Platzhalter ein und maskiert Werte im HTML', () => {
    const mail = renderMail(blocks([{ kind: 'p', text: 'Guten Tag {{name}}' }]), { name: '<b>Erika</b>' })
    expect(mail.subject).toBe('Hallo <b>Erika</b>')
    expect(mail.html).toContain('Guten Tag &lt;b&gt;Erika&lt;/b&gt;')
    expect(mail.text).toContain('Guten Tag <b>Erika</b>')
  })

  it('lässt Bausteine mit leeren Platzhaltern weg, aber nicht solche mit eigenem Text', () => {
    const t = blocks([
      { kind: 'quote', text: '{{notiz}}' },
      { kind: 'p', text: 'Notiz: {{notiz}}' },
      { kind: 'button', label: 'Öffnen', href: '{{link}}' },
    ])
    const mail = renderMail(t, { name: 'A', notiz: '', link: '' })
    expect(mail.html).not.toContain('blockquote')
    expect(mail.html).not.toContain('Öffnen')
    expect(mail.text).toContain('Notiz:')
  })

  it('erlaubt in Buttons nur http(s)- und mailto-Links', () => {
    const t = blocks([{ kind: 'button', label: 'X', href: '{{link}}' }])
    expect(renderMail(t, { link: 'javascript:alert(1)' }).html).toContain('href="#"')
    expect(renderMail(t, { link: 'https://a.example/x?a=1&b=2' }).html).toContain('href="https://a.example/x?a=1&amp;b=2"')
  })

  it('maskiert Werte auch im HTML-Modus und erzeugt eine Textfassung', () => {
    const t: StoredTemplate = { subject: 'S', mode: 'html', blocks: [], html: '<p>Hallo <a href="{{link}}">{{name}}</a></p>' }
    const mail = renderMail(t, { name: '<script>x</script>', link: 'https://a.example' })
    expect(mail.html).not.toContain('<script>')
    expect(mail.text).toContain('<script>x</script>: https://a.example')
  })

  it('findet unbekannte Platzhalter', () => {
    const t = { ...defaultTemplate('assigned'), subject: '{{auftrag}} {{preis}}' }
    expect(unknownPlaceholders('assigned', t)).toEqual(['preis'])
    expect(unknownPlaceholders('assigned', defaultTemplate('assigned'))).toEqual([])
  })

  it('übernimmt Bausteine beim Umschalten auf HTML mit Platzhaltern', () => {
    const html = blocksToHtml([
      { kind: 'p', text: 'Hallo {{name}} & Co' },
      { kind: 'button', label: 'Öffnen', href: '{{link}}' },
    ])
    expect(html).toContain('Hallo {{name}} &amp; Co')
    expect(html).toContain('href="{{link}}"')
  })

  it('bringt Signatur und Fußzeile aus dem Layout mit', () => {
    const mail = renderMail(
      defaultTemplate('registration_rejected'),
      { name: 'Erika' },
      {
        senderName: '',
        replyTo: '',
        header: 'Fachschaftsdruckerei',
        signature: 'Viele Grüße\nEure Druckerei',
        footer: 'Impressum',
      },
    )
    expect(mail.html).toContain('Fachschaftsdruckerei')
    expect(mail.html).toContain('Viele Grüße<br>Eure Druckerei')
    expect(mail.text).toMatch(/-- \n\nViele Grüße/)
  })

  it('ersetzt nur den Anzeigenamen des Absenders', () => {
    expect(fromWithName('Drucktool <noreply@example.com>', 'Druckerei')).toBe('"Druckerei" <noreply@example.com>')
    expect(fromWithName('noreply@example.com', '')).toBe('noreply@example.com')
  })

  it('merkt sich Vorlage und Werte, damit Anpassungen beim Versand greifen', () => {
    expect(registrationRejectedMail({ name: 'Erika' }).template).toEqual({
      key: 'registration_rejected',
      vars: { name: 'Erika' },
    })
  })
})

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

describe.skipIf(!url)('E-Mail-Vorlagen anpassen (Integration)', async () => {
  const { getDb, schema } = await import('~/server/db/client.server')
  const { enqueueMail } = await import('~/server/mail/outbox.server')
  const admin = await import('~/server/mail/mail-admin.server')
  type Actor = { id: string; email: string; role: 'admin' | 'staff' }
  let adminUser: Actor
  let staffUser: Actor

  async function user(role: 'admin' | 'staff') {
    const email = `vorlage-${role}-${Date.now()}@test`
    const [row] = await getDb().insert(schema.users).values({ email, lastName: role, role, status: 'active' }).returning()
    return { id: row!.id, email, role }
  }

  async function outbox(to: string) {
    return getDb().select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, to))
  }

  beforeAll(async () => {
    adminUser = await user('admin')
    staffUser = await user('staff')
  })

  afterAll(async () => {
    await getDb().delete(schema.mailTemplates)
    await getDb().delete(schema.settings).where(eq(schema.settings.key, 'mail_layout'))
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  it('verwendet beim Versand die angepasste Vorlage und das Layout', async () => {
    await admin.saveMailTemplate(adminUser, {
      key: 'comment',
      template: {
        subject: 'Neu bei {{auftrag}}',
        mode: 'blocks',
        blocks: [{ kind: 'p', text: '{{akteur}} schreibt: {{nachricht}}' }],
        html: '',
      },
    })
    await admin.saveMailLayout(adminUser, { senderName: 'Druckerei', replyTo: '', header: 'Kopf', signature: 'Gruß', footer: '' })
    const to = `empfaenger-${Date.now()}@test`
    await getDb().transaction((tx) =>
      enqueueMail(
        tx,
        [to],
        commentMail({ id: 'x', number: 26100001, title: 'Skript', actorName: 'Max', body: '<i>hi</i>', internal: false }),
      ),
    )
    const [mail] = await outbox(to)
    expect(mail!.subject).toBe('Neu bei #26100001 Skript')
    expect(mail!.text).toContain('Max schreibt: <i>hi</i>')
    expect(mail!.html).toContain('&lt;i&gt;hi&lt;/i&gt;')
    expect(mail!.html).toContain('Gruß')

    const list = await admin.listMailTemplates(adminUser)
    expect(list.layout.senderName).toBe('Druckerei')
    expect(list.templates.find((t) => t.key === 'comment')!.customized).toBe(true)
  })

  it('setzt eine Vorlage auf den Standard zurück und protokolliert das', async () => {
    await admin.resetMailTemplate(adminUser, 'comment')
    const rows = await getDb().select().from(schema.mailTemplates).where(eq(schema.mailTemplates.key, 'comment'))
    expect(rows).toHaveLength(0)
    const audit = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.targetId, 'comment'))
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['mail_template.updated', 'mail_template.reset']))
  })

  it('lehnt unbekannte Platzhalter und leere Vorlagen ab', async () => {
    const base = defaultTemplate('assigned')
    await expect(
      admin.saveMailTemplate(adminUser, { key: 'assigned', template: { ...base, subject: '{{preis}}' } }),
    ).rejects.toThrow('Unbekannte Platzhalter: {{preis}}')
    await expect(admin.saveMailTemplate(adminUser, { key: 'assigned', template: { ...base, blocks: [] } })).rejects.toThrow()
    await expect(
      admin.saveMailTemplate(adminUser, { key: 'assigned', template: { ...base, mode: 'html', html: ' ' } }),
    ).rejects.toThrow()
  })

  it('erlaubt Änderungen nur Admins', async () => {
    await expect(admin.listMailTemplates(staffUser)).rejects.toThrow('Keine Berechtigung')
    await expect(admin.resetMailTemplate(staffUser, 'comment')).rejects.toThrow('Keine Berechtigung')
  })

  it('schickt eine Testmail mit Beispielwerten an die eigene Adresse', async () => {
    await admin.sendTestMail(adminUser, { key: 'login_link', template: defaultTemplate('login_link') })
    const [mail] = await outbox(adminUser.email)
    expect(mail!.subject).toMatch(/^\[Test\] /)
    expect(mail!.text).toContain('https://druck.example.com/anmelden?token=beispiel')
  })
})
