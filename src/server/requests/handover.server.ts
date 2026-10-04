// Abholung bzw. Zustellung fertiger Aufträge erfassen (Issue #173). „Fertig“ bleibt der letzte Status; ob der Auftrag
// abgeholt oder per Hauspost zugestellt wurde, steht in eigenen Feldern und im Verlauf. So bleiben Workflow und
// Kundenmails beim Statuswechsel unverändert.
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { HANDOVER_LABELS } from '~/lib/order'
import { getDb, schema } from '../db/client.server'

const { requests, requestEvents } = schema

export const handoverSchema = z.object({
  id: z.uuid(),
  /** true: abgeholt bzw. zugestellt; false: zurücknehmen, der Auftrag liegt wieder in der Druckerei. */
  handedOver: z.boolean(),
})

export async function recordHandover(actorId: string, input: z.infer<typeof handoverSchema>) {
  return getDb().transaction(async (tx) => {
    const [current] = await tx
      .select({ status: requests.status, deliveryMethod: requests.deliveryMethod, handedOverAt: requests.handedOverAt })
      .from(requests)
      .where(eq(requests.id, input.id))
      .for('update')
    if (!current) throw new Error('Auftrag nicht gefunden')
    if (current.status !== 'completed')
      throw new Error('Abholung und Zustellung lassen sich nur bei fertigen Aufträgen erfassen.')
    const label = HANDOVER_LABELS[current.deliveryMethod]
    if (input.handedOver && current.handedOverAt) throw new Error(`Der Auftrag ist bereits als „${label}“ erfasst.`)
    if (!input.handedOver && !current.handedOverAt) throw new Error(`Der Auftrag ist nicht als „${label}“ erfasst.`)
    await tx
      .update(requests)
      .set({
        handedOverAt: input.handedOver ? new Date() : null,
        handedOverById: input.handedOver ? actorId : null,
        updatedAt: sql`now()`,
      })
      .where(eq(requests.id, input.id))
    // Für Kunden sichtbar: sie sehen im Verlauf, wann ihr Auftrag abgeholt oder zugestellt wurde.
    await tx.insert(requestEvents).values({
      requestId: input.id,
      actorId,
      type: 'handed_over',
      data: { handedOver: input.handedOver, deliveryMethod: current.deliveryMethod },
    })
  })
}
