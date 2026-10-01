import { createServerFn } from '@tanstack/react-start'
import { requireUser } from '../auth/guards.server'
import { getDashboard } from './dashboard.server'

export const getDashboardFn = createServerFn({ method: 'GET' }).handler(async () => getDashboard(await requireUser()))
