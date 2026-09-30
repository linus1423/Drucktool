import { isAdminRole, isStaffRole } from '~/lib/roles'
import { getSessionUser, type SessionUser } from './session.server'

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser()
  if (!user) throw new Error('Nicht angemeldet')
  return user
}

export async function requireStaff(): Promise<SessionUser> {
  const user = await requireUser()
  if (!isStaffRole(user.role)) throw new Error('Keine Berechtigung')
  return user
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser()
  if (!isAdminRole(user.role)) throw new Error('Keine Berechtigung')
  return user
}

export async function requireSuperadmin(): Promise<SessionUser> {
  const user = await requireUser()
  if (user.role !== 'superadmin') throw new Error('Keine Berechtigung')
  return user
}
