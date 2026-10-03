import { notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireAdmin, requireStaff, requireSuperadmin } from '../auth/guards.server'
import {
  approveRegistration,
  approveSchema,
  createUser,
  createUserSchema,
  getOrganisation,
  listActiveOrganisations,
  listOrganisations,
  listPendingRegistrations,
  listUsers,
  OrganisationNotFoundError,
  rejectRegistration,
  saveOrganisation,
  saveOrganisationSchema,
  setOrganisationAdmin,
  setOrganisationAdminSchema,
  updateUser,
  updateUserSchema,
} from './admin.server'
import { anonymizeUser } from '../privacy/privacy.server'
import {
  listOpenOrganisationRequests,
  resolveOrganisationRequest,
  resolveOrganisationRequestSchema,
} from '../organisations/organisations.server'

export const listPendingRegistrationsFn = createServerFn({ method: 'GET' }).handler(async () => {
  await requireSuperadmin()
  return listPendingRegistrations()
})

export const approveRegistrationFn = createServerFn({ method: 'POST' })
  .validator(approveSchema)
  .handler(async ({ data }) => approveRegistration(await requireSuperadmin(), data))

export const rejectRegistrationFn = createServerFn({ method: 'POST' })
  .validator(z.object({ userId: z.uuid() }))
  .handler(async ({ data }) => rejectRegistration(await requireSuperadmin(), data.userId))

export const listOrganisationsFn = createServerFn({ method: 'GET' }).handler(async () => {
  await requireAdmin()
  return listOrganisations()
})

/** Für Auswahlfelder, z. B. wenn Mitarbeiter eine Anfrage für einen Kunden anlegen. */
export const listActiveOrganisationsFn = createServerFn({ method: 'GET' }).handler(async () => {
  await requireStaff()
  return listActiveOrganisations()
})

export const getOrganisationFn = createServerFn({ method: 'GET' })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }) => {
    await requireAdmin()
    try {
      return await getOrganisation(data.id)
    } catch (e) {
      // HTTP 404 statt 500 für unbekannte Organisationen (Issue #141).
      if (e instanceof OrganisationNotFoundError) throw notFound()
      throw e
    }
  })

export const setOrganisationAdminFn = createServerFn({ method: 'POST' })
  .validator(setOrganisationAdminSchema)
  .handler(async ({ data }) => setOrganisationAdmin(await requireAdmin(), data))

export const saveOrganisationFn = createServerFn({ method: 'POST' })
  .validator(saveOrganisationSchema)
  .handler(async ({ data }) => saveOrganisation(await requireAdmin(), data))

export const listUsersFn = createServerFn({ method: 'GET' }).handler(async () => {
  await requireAdmin()
  return listUsers()
})

export const createUserFn = createServerFn({ method: 'POST' })
  .validator(createUserSchema)
  .handler(async ({ data }) => createUser(await requireAdmin(), data))

export const updateUserFn = createServerFn({ method: 'POST' })
  .validator(updateUserSchema)
  .handler(async ({ data }) => updateUser(await requireAdmin(), data))

/** Entfernt die personenbezogenen Daten eines Kontos (DSGVO). Aufträge bleiben erhalten. */
export const anonymizeUserFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }) => {
    await anonymizeUser(await requireAdmin(), data.id)
    return { ok: true as const }
  })

/** Offene Organisationsanfragen von Kunden; Mitarbeiter und Admins bearbeiten sie. */
export const listOrganisationRequestsFn = createServerFn({ method: 'GET' }).handler(async () => {
  await requireStaff()
  return listOpenOrganisationRequests()
})

export const resolveOrganisationRequestFn = createServerFn({ method: 'POST' })
  .validator(resolveOrganisationRequestSchema)
  .handler(async ({ data }) => resolveOrganisationRequest(await requireStaff(), data))
