import { createServerFn } from '@tanstack/react-start'
import { requireStaff } from '../auth/guards.server'
import { pendingLexwareCount } from './lexware.server'

export const pendingLexwareCountFn = createServerFn({ method: 'GET' }).handler(async () => {
  await requireStaff()
  return pendingLexwareCount()
})
