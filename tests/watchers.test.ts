import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { findMentions } from '~/server/requests/watchers.server'
import { BILLING } from './fixtures'
import { placeOrder } from './order-fixture'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

describe('Erwähnungen erkennen', () => {
  const staff = [
    { id: 'a', name: 'Anna' },
    { id: 'am', name: 'Anna Maier' },
    { id: 'b', name: 'Bernd' },
  ]

  it('findet Namen mit @ und bevorzugt den längeren Namen', () => {
    expect(findMentions('Hallo @Anna Maier, bitte prüfen', staff)).toEqual(['am'])
    expect(findMentions('@anna und @Bernd', staff).sort()).toEqual(['a', 'b'])
  })

  it('ignoriert E-Mail-Adressen und Namensteile', () => {
    expect(findMentions('schreib an x@Bernd.de', staff)).toEqual([])
    expect(findMentions('@Berndt', staff)).toEqual([])
    expect(findMentions('ohne Erwähnung', staff)).toEqual([])
  })
})

describe.skipIf(!url)('Beobachter (Integration)', async () => {
  const { getDb, schema } = await import('~/server/db/client.server')
  const { addComment, assignRequest, changeStatus, getRequestDetail, listRequests, setWatchingRequest } =
    await import('~/server/requests/requests.server')
  type Principal = import('~/server/requests/requests.server').Principal
  let customer: Principal
  let anna: Principal
  let bernd: Principal
  let other: Principal
  const tag = `beob-${Date.now()}`
  const mail = (who: string) => `${tag}-${who}@test`

  async function mailsTo(who: string) {
    return getDb()
      .select()
      .from(schema.emailOutbox)
      .where(eq(schema.emailOutbox.to, mail(who)))
  }

  beforeAll(async () => {
    const rows = await getDb()
      .insert(schema.users)
      .values([
        { email: mail('k'), name: `Kunde ${tag}`, role: 'customer', status: 'active', billingAddress: BILLING },
        { email: mail('anna'), name: `Anna ${tag}`, role: 'staff', status: 'active' },
        { email: mail('bernd'), name: `Bernd ${tag}`, role: 'staff', status: 'active' },
        { email: mail('other'), name: `Kim ${tag}`, role: 'customer', status: 'active', billingAddress: BILLING },
      ])
      .returning()
    customer = { id: rows[0]!.id, role: 'customer', organisationId: null }
    anna = { id: rows[1]!.id, role: 'staff', organisationId: null }
    bernd = { id: rows[2]!.id, role: 'staff', organisationId: null }
    other = { id: rows[3]!.id, role: 'customer', organisationId: null }
  })

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  it('Ersteller und Zuständiger beobachten automatisch', async () => {
    const { id } = await placeOrder(customer, { title: tag })
    await assignRequest(anna, { id, version: 1, assigneeId: anna.id })
    expect((await getRequestDetail(customer, id)).watching).toBe(true)
    const view = await getRequestDetail(anna, id)
    expect(view.watching).toBe(true)
    expect(view.watchers.map((w) => w.id).sort()).toEqual([customer.id, anna.id].sort())
    // Kunden sehen nicht, wer sonst noch beobachtet.
    expect((await getRequestDetail(customer, id)).watchers).toEqual([])
    expect((await getRequestDetail(bernd, id)).watching).toBe(false)
  })

  it('beobachtende Mitarbeiter bekommen Nachrichten und Statuswechsel', async () => {
    const { id } = await placeOrder(customer, { title: `${tag} status` })
    await assignRequest(anna, { id, version: 1, assigneeId: anna.id })
    await setWatchingRequest(bernd, { id, watching: true })
    await addComment(customer, { id, body: `Frage ${tag}`, internal: false })
    expect((await mailsTo('bernd')).some((m) => m.text.includes(`Frage ${tag}`))).toBe(true)
    await changeStatus(anna, { id, version: 2, to: 'confirmed' })
    const status = (await mailsTo('bernd')).filter((m) => m.subject.includes(`${tag} status`) && m.subject.includes('Bestätigt'))
    expect(status).toHaveLength(1)
    // Mitarbeiter bekommen den Wechsel ohne den Erklärtext für Kunden.
    const customerMail = (await mailsTo('k')).find((m) => m.subject === status[0]!.subject)!
    expect(status[0]!.text.length).toBeLessThan(customerMail.text.length)
  })

  it('wer das Beobachten abschaltet, bekommt keine Mails mehr', async () => {
    const { id } = await placeOrder(customer, { title: `${tag} stumm` })
    await assignRequest(anna, { id, version: 1, assigneeId: anna.id })
    expect((await setWatchingRequest(customer, { id, watching: false })).watching).toBe(false)
    expect((await setWatchingRequest(anna, { id, watching: false })).watching).toBe(false)
    await addComment(bernd, { id, body: `Still ${tag}`, internal: false })
    expect((await mailsTo('k')).some((m) => m.text.includes(`Still ${tag}`))).toBe(false)
    expect((await mailsTo('anna')).some((m) => m.text.includes(`Still ${tag}`))).toBe(false)
    const own = await listRequests(anna, { watching: true, pageSize: 100 })
    expect(own.rows.some((r) => r.id === id)).toBe(false)
  })

  it('Erwähnte bekommen eine eigene Mail und beobachten danach', async () => {
    const { id } = await placeOrder(customer, { title: `${tag} erwähnt` })
    await assignRequest(anna, { id, version: 1, assigneeId: anna.id })
    await addComment(anna, { id, body: `@Bernd ${tag} kannst du drucken?`, internal: true })
    const toBernd = (await mailsTo('bernd')).filter((m) => m.text.includes('kannst du drucken'))
    expect(toBernd).toHaveLength(1)
    expect(toBernd[0]!.subject).toContain('hat Sie erwähnt')
    // Interne Notizen erreichen den Kunden nie.
    expect((await mailsTo('k')).some((m) => m.text.includes('kannst du drucken'))).toBe(false)
    const view = await getRequestDetail(anna, id)
    expect(view.comments.at(-1)!.mentions.map((m) => m.id)).toEqual([bernd.id])
    expect(view.watchers.some((w) => w.id === bernd.id)).toBe(true)
    const forBernd = await listRequests(bernd, { watching: true, pageSize: 100 })
    expect(forBernd.rows.some((r) => r.id === id)).toBe(true)
  })

  it('Kunden können niemanden erwähnen und fremde Aufträge nicht beobachten', async () => {
    const { id } = await placeOrder(customer, { title: `${tag} kunde` })
    await addComment(customer, { id, body: `@Anna ${tag} hallo`, internal: false })
    const [comment] = await getDb()
      .select({ mentionedIds: schema.requestComments.mentionedIds })
      .from(schema.requestComments)
      .where(and(eq(schema.requestComments.requestId, id)))
    expect(comment!.mentionedIds).toEqual([])
    await expect(setWatchingRequest(other, { id, watching: true })).rejects.toThrow('nicht gefunden')
    const rows = await getDb()
      .select()
      .from(schema.requestWatchers)
      .where(inArray(schema.requestWatchers.userId, [other.id]))
    expect(rows).toEqual([])
  })

  it('neu Zuständige beobachten wieder, auch nach dem Abschalten', async () => {
    const { id } = await placeOrder(customer, { title: `${tag} zurueck` })
    await setWatchingRequest(bernd, { id, watching: false })
    await assignRequest(anna, { id, version: 1, assigneeId: bernd.id })
    expect((await getRequestDetail(bernd, id)).watching).toBe(true)
  })
})
