import { createServerFn } from '@tanstack/react-start'
import { requireStaff } from '../auth/guards.server'
import { invoiceRecordSchema, pendingLexwareCount, recordInvoice } from './lexware.server'

export const pendingLexwareCountFn = createServerFn({ method: 'GET' }).handler(async () => {
  await requireStaff()
  return pendingLexwareCount()
})

export const recordInvoiceFn = createServerFn({ method: 'POST' })
  .validator(invoiceRecordSchema)
  .handler(async ({ data }) => recordInvoice((await requireStaff()).id, data))
