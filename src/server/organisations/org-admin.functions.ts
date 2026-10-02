import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from '../auth/guards.server'
import {
  acceptInvite,
  createInvite,
  describeInvite,
  getManagedOrganisation,
  leaveOrganisation,
  listReadableOrganisations,
  memberActionSchema,
  organisationDetailsInputSchema,
  removeMember,
  revokeInvite,
  setMemberAdmin,
  setMemberAdminSchema,
  updateOrganisationDetails,
} from './org-admin.server'

const organisationIdSchema = z.object({ organisationId: z.uuid() })
const tokenSchema = z.object({ token: z.string().min(20).max(100) })

export const listReadableOrganisationsFn = createServerFn({ method: 'GET' }).handler(async () =>
  listReadableOrganisations(await requireUser()),
)

export const getManagedOrganisationFn = createServerFn({ method: 'GET' })
  .validator(organisationIdSchema)
  .handler(async ({ data }) => getManagedOrganisation(await requireUser(), data.organisationId))

export const createInviteFn = createServerFn({ method: 'POST' })
  .validator(organisationIdSchema)
  .handler(async ({ data }) => createInvite(await requireUser(), data.organisationId))

export const revokeInviteFn = createServerFn({ method: 'POST' })
  .validator(organisationIdSchema.extend({ inviteId: z.uuid() }))
  .handler(async ({ data }) => revokeInvite(await requireUser(), data))

export const removeMemberFn = createServerFn({ method: 'POST' })
  .validator(memberActionSchema)
  .handler(async ({ data }) => removeMember(await requireUser(), data))

export const setMemberAdminFn = createServerFn({ method: 'POST' })
  .validator(setMemberAdminSchema)
  .handler(async ({ data }) => setMemberAdmin(await requireUser(), data))

export const updateOrganisationDetailsFn = createServerFn({ method: 'POST' })
  .validator(organisationDetailsInputSchema)
  .handler(async ({ data }) => updateOrganisationDetails(await requireUser(), data))

export const leaveOrganisationFn = createServerFn({ method: 'POST' })
  .validator(organisationIdSchema)
  .handler(async ({ data }) => leaveOrganisation(await requireUser(), data.organisationId))

export const describeInviteFn = createServerFn({ method: 'GET' })
  .validator(tokenSchema)
  .handler(async ({ data }) => describeInvite(await requireUser(), data.token))

export const acceptInviteFn = createServerFn({ method: 'POST' })
  .validator(tokenSchema)
  .handler(async ({ data }) => acceptInvite(await requireUser(), data.token))
