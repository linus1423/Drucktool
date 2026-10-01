import { queryOptions } from '@tanstack/react-query'
import { getAdminCatalogFn, getOrderCatalogFn, listCatalogChangesFn } from '~/server/catalog/catalog.functions'
import { getCurrentUser, getSiteLinksFn } from '~/server/auth/auth.functions'
import { getMyAccountFn } from '~/server/account/account.functions'
import { getRequestFn, listAssignableStaffFn, listBoardFn, listRequestsFn } from '~/server/requests/requests.functions'
import {
  getOrganisationFn,
  listActiveOrganisationsFn,
  listOrganisationsFn,
  listPendingRegistrationsFn,
  listUsersFn,
} from '~/server/admin/admin.functions'
import { getDashboardFn } from '~/server/requests/dashboard.functions'
import { listAuditLogFn } from '~/server/audit/audit.functions'
import { listMailTemplatesFn } from '~/server/mail/mail-templates.functions'
import type { AuditFilter } from '~/server/audit/audit.server'
import type { RequestStatus } from './status'

export type RequestListFilter = {
  status?: RequestStatus
  open?: boolean
  assignedToMe?: boolean
  search?: string
}

export const currentUserQuery = queryOptions({
  queryKey: ['current-user'],
  queryFn: () => getCurrentUser(),
  staleTime: 60_000,
})

export const siteLinksQuery = queryOptions({
  queryKey: ['site-links'],
  queryFn: () => getSiteLinksFn(),
  staleTime: Infinity,
})

export const requestListQuery = (filter: RequestListFilter) =>
  queryOptions({
    queryKey: ['requests', 'list', filter],
    queryFn: () => listRequestsFn({ data: filter }),
  })

export const requestBoardQuery = (filter: { mine?: boolean; search?: string }) =>
  queryOptions({
    queryKey: ['requests', 'list', 'board', filter],
    queryFn: () => listBoardFn({ data: filter }),
  })

// Unter 'requests', damit Statuswechsel die Kennzahlen mit auffrischen.
export const dashboardQuery = queryOptions({
  queryKey: ['requests', 'dashboard'],
  queryFn: () => getDashboardFn(),
})

export const requestDetailQuery = (id: string) =>
  queryOptions({
    queryKey: ['requests', 'detail', id],
    queryFn: () => getRequestFn({ data: { id } }),
  })

export const assignableStaffQuery = queryOptions({
  queryKey: ['staff', 'assignable'],
  queryFn: () => listAssignableStaffFn(),
  staleTime: 5 * 60_000,
})

export const pendingRegistrationsQuery = queryOptions({
  queryKey: ['admin', 'registrations'],
  queryFn: () => listPendingRegistrationsFn(),
})

export const organisationsQuery = queryOptions({
  queryKey: ['admin', 'organisations'],
  queryFn: () => listOrganisationsFn(),
})

export const activeOrganisationsQuery = queryOptions({
  queryKey: ['organisations', 'active'],
  queryFn: () => listActiveOrganisationsFn(),
})

export const organisationQuery = (id: string) =>
  queryOptions({
    queryKey: ['admin', 'organisations', id],
    queryFn: () => getOrganisationFn({ data: { id } }),
  })

export const usersQuery = queryOptions({
  queryKey: ['admin', 'users'],
  queryFn: () => listUsersFn(),
})

export const adminCatalogQuery = queryOptions({
  queryKey: ['catalog', 'admin'],
  queryFn: () => getAdminCatalogFn(),
})

export const orderCatalogQuery = queryOptions({
  queryKey: ['catalog', 'order'],
  queryFn: () => getOrderCatalogFn(),
  staleTime: 60_000,
})

export const catalogChangesQuery = queryOptions({
  queryKey: ['catalog', 'changes'],
  queryFn: () => listCatalogChangesFn(),
})

export const accountQuery = queryOptions({ queryKey: ['account'], queryFn: () => getMyAccountFn() })

export const auditLogQuery = (filter: AuditFilter) =>
  queryOptions({
    queryKey: ['admin', 'audit', filter],
    queryFn: () => listAuditLogFn({ data: filter }),
  })

export const mailTemplatesQuery = queryOptions({
  queryKey: ['admin', 'mail-templates'],
  queryFn: () => listMailTemplatesFn(),
})
