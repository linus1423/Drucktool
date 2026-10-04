import { createServerFn } from '@tanstack/react-start'
import { requireStaff } from '../auth/guards.server'
import { handoverSchema, recordHandover } from './handover.server'

/** Fertigen Auftrag als abgeholt bzw. zugestellt markieren oder das zurücknehmen (Issue #173), nur Mitarbeiter. */
export const recordHandoverFn = createServerFn({ method: 'POST' })
  .validator(handoverSchema)
  .handler(async ({ data }) => recordHandover((await requireStaff()).id, data))
