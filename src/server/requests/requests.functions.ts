import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireStaff, requireUser } from '../auth/guards.server'
import {
  answerChange,
  answerChangeSchema,
  setDates,
  setDatesSchema,
  prepareReorder,
  proposeChange,
  proposeChangeSchema,
  withdrawChange,
  withdrawChangeSchema,
  addComment,
  addCommentSchema,
  assignRequest,
  assignSchema,
  changeStatus,
  changeStatusSchema,
  createRequest,
  createRequestSchema,
  getRequestDetail,
  internalStatusSchema,
  setInternalStatus,
  listAssignableStaff,
  listFilterSchema,
  listRequests,
  updateRequest,
  updateRequestSchema,
  setWatchingRequest,
  boardFilterSchema,
  listBoard,
  markRequestRead,
  markReadSchema,
  watchSchema,
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

export const setInternalStatusFn = createServerFn({ method: 'POST' })
  .validator(internalStatusSchema)
  .handler(async ({ data }) => setInternalStatus(await requireStaff(), data))

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

export const proposeChangeFn = createServerFn({ method: 'POST' })
  .validator(proposeChangeSchema)
  .handler(async ({ data }) => proposeChange(await requireStaff(), data))

export const answerChangeFn = createServerFn({ method: 'POST' })
  .validator(answerChangeSchema)
  .handler(async ({ data }) => answerChange(await requireUser(), data))

export const withdrawChangeFn = createServerFn({ method: 'POST' })
  .validator(withdrawChangeSchema)
  .handler(async ({ data }) => withdrawChange(await requireStaff(), data))

export const setDatesFn = createServerFn({ method: 'POST' })
  .validator(setDatesSchema)
  .handler(async ({ data }) => setDates(await requireStaff(), data))

export const prepareReorderFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }) => prepareReorder(await requireUser(), data.id))

export const setWatchingFn = createServerFn({ method: 'POST' })
  .validator(watchSchema)
  .handler(async ({ data }) => setWatchingRequest(await requireUser(), data))

export const listBoardFn = createServerFn({ method: 'GET' })
  .validator(boardFilterSchema)
  .handler(async ({ data }) => listBoard(await requireStaff(), data))
export const markReadFn = createServerFn({ method: 'POST' })
  .validator(markReadSchema)
  .handler(async ({ data }) => markRequestRead(await requireUser(), data))
