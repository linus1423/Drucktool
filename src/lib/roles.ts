export const USER_ROLES = ['superadmin', 'admin', 'staff', 'customer'] as const
export type UserRole = (typeof USER_ROLES)[number]

export const USER_STATUSES = ['pending', 'active', 'rejected', 'disabled'] as const
export type UserStatus = (typeof USER_STATUSES)[number]

export const ROLE_LABELS: Record<UserRole, string> = {
  superadmin: 'Superadmin',
  admin: 'Administrator',
  staff: 'Mitarbeiter',
  customer: 'Kunde',
}

export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  pending: 'Wartet auf Freigabe',
  active: 'Aktiv',
  rejected: 'Abgelehnt',
  disabled: 'Deaktiviert',
}

export function isStaffRole(role: UserRole): boolean {
  return role !== 'customer'
}

export function isAdminRole(role: UserRole): boolean {
  return role === 'admin' || role === 'superadmin'
}

export const ORG_STATUS: Record<'pending' | 'active' | 'disabled', { label: string; className: string }> = {
  active: { label: 'Aktiv', className: 'bg-emerald-100 text-emerald-800' },
  pending: { label: 'Wartet auf Freigabe', className: 'bg-amber-100 text-amber-800' },
  disabled: { label: 'Deaktiviert', className: 'bg-slate-200 text-slate-700' },
}
