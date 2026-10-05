import { queryOptions } from '@tanstack/react-query'
import { getAdminCatalogFn, getOrderCatalogFn, listCatalogChangesFn } from '~/server/catalog/catalog.functions'
import { getCurrentUser } from '~/server/auth/auth.functions'
import { getDesignSettingsFn, getLegalTextFn, getPublicDesignFn } from '~/server/design/design.functions'
import { getMyAccountFn } from '~/server/account/account.functions'
import { getRequestFn, listAssignableStaffFn, listBoardFn, listRequestsFn } from '~/server/requests/requests.functions'
import {
  getOrganisationFn,
  listActiveOrganisationsFn,
  listOrganisationRequestsFn,
  listOrganisationsFn,
  listPendingRegistrationsFn,
  listUsersFn,
} from '~/server/admin/admin.functions'
import { getDashboardFn } from '~/server/requests/dashboard.functions'
import { pendingLexwareCountFn } from '~/server/invoices/lexware.functions'
import { listAuditLogFn } from '~/server/audit/audit.functions'
import { getAppInfoFn } from '~/server/app-info.functions'
import { listScriptsFn } from '~/server/scripts/scripts.functions'
import {
  describeInviteFn,
  getManagedOrganisationFn,
  listReadableOrganisationsFn,
} from '~/server/organisations/org-admin.functions'
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

/** Name, Logo, Farben und Fußzeile (Issue #186); nach dem Speichern auf der Design-Seite neu geladen. */
export const designQuery = queryOptions({
  queryKey: ['design'],
  queryFn: () => getPublicDesignFn(),
  staleTime: 5 * 60_000,
})

export const designSettingsQuery = queryOptions({
  queryKey: ['admin', 'design'],
  queryFn: () => getDesignSettingsFn(),
})

export const legalTextQuery = (page: 'imprint' | 'privacy') =>
  queryOptions({ queryKey: ['legal-text', page], queryFn: () => getLegalTextFn({ data: { page } }) })

export const appInfoQuery = queryOptions({
  queryKey: ['app-info'],
  queryFn: () => getAppInfoFn(),
  staleTime: Infinity,
})

export const requestListQuery = (filter: RequestListFilter) =>
  queryOptions({
    queryKey: ['requests', 'list', filter],
    queryFn: () => listRequestsFn({ data: filter }),
  })

export const requestBoardQuery = (filter: { mine?: boolean; search?: string; ready?: boolean }) =>
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

// Unter 'requests', damit „Fertig“ und der Export die Zahl auffrischen (Issue #53).
export const pendingLexwareQuery = queryOptions({
  queryKey: ['requests', 'lexware-pending'],
  queryFn: () => pendingLexwareCountFn(),
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

export const organisationRequestsQuery = queryOptions({
  queryKey: ['organisations', 'requests'],
  queryFn: () => listOrganisationRequestsFn(),
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

/** Organisationen, deren Aufträge der Kunde mitliest: verwaltete und SVK (Issues #12, #59). */
export const readableOrganisationsQuery = queryOptions({
  queryKey: ['organisations', 'readable'],
  queryFn: () => listReadableOrganisationsFn(),
})

export const managedOrganisationQuery = (organisationId: string) =>
  queryOptions({
    queryKey: ['organisations', 'managed', organisationId],
    queryFn: () => getManagedOrganisationFn({ data: { organisationId } }),
  })

export const inviteQuery = (token: string) =>
  queryOptions({
    queryKey: ['organisations', 'invite', token],
    queryFn: () => describeInviteFn({ data: { token } }),
    staleTime: 0,
  })

/** Skripte der SVK (Issue #59). */
export const scriptsQuery = (filter: { semester?: string; archived?: boolean }) =>
  queryOptions({ queryKey: ['scripts', filter], queryFn: () => listScriptsFn({ data: filter }) })

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
