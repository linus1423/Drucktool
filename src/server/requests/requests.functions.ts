import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireStaff, requireUser } from '../auth/guards.server'
import {
  addComment,
  addCommentSchema,
  assignRequest,
  assignSchema,
  changeStatus,
  changeStatusSchema,
  createRequest,
  createRequestSchema,
  getRequestDetail,
  listAssignableStaff,
  listFilterSchema,
  listRequests,
  updateRequest,
  updateRequestSchema,
} from './requests.server'

export const listRequestsFn = createServerFn({ method: 'GET' })
  .validator(listFilterSchema)
  .handler(async ({ data }) => listRequests(await requireUser(), data))

export const getRequestFn = createServerFn({ method: 'GET' })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }) => getRequestDetail(await requireUser(), data.id))

export const createRequestFn = createServerFn({ method: 'POST' })
  .validator(createRequestSchema)
  .handler(async ({ data }) => createRequest(await requireUser(), data))

export const updateRequestFn = createServerFn({ method: 'POST' })
  .validator(updateRequestSchema)
  .handler(async ({ data }) => updateRequest(await requireUser(), data))

export const changeStatusFn = createServerFn({ method: 'POST' })
  .validator(changeStatusSchema)
  .handler(async ({ data }) => changeStatus(await requireUser(), data))

export const assignRequestFn = createServerFn({ method: 'POST' })
  .validator(assignSchema)
  .handler(async ({ data }) => assignRequest(await requireStaff(), data))

export const addCommentFn = createServerFn({ method: 'POST' })
  .validator(addCommentSchema)
  .handler(async ({ data }) => addComment(await requireUser(), data))

export const listAssignableStaffFn = createServerFn({ method: 'GET' }).handler(async () => {
  await requireStaff()
  return listAssignableStaff()
})
