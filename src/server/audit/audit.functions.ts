import { createServerFn } from '@tanstack/react-start'
import { requireSuperadmin } from '../auth/guards.server'
import { auditFilterSchema, listAuditLog } from './audit.server'

export const listAuditLogFn = createServerFn({ method: 'GET' })
  .validator(auditFilterSchema)
  .handler(async ({ data }) => {
    await requireSuperadmin()
    return listAuditLog(data)
  })
