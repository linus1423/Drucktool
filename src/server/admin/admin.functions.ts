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
  rejectRegistration,
  saveOrganisation,
  saveOrganisationSchema,
  updateUser,
  updateUserSchema,
} from './admin.server'

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
    return getOrganisation(data.id)
  })

export const saveOrganisationFn = createServerFn({ method: 'POST' })
  .validator(saveOrganisationSchema)
  .handler(async ({ data }) => {
    await requireAdmin()
    return saveOrganisation(data)
  })

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
