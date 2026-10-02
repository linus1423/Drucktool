import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from '../auth/guards.server'
import {
  copyScript,
  createScript,
  createScriptSchema,
  describeScriptForOrder,
  listScripts,
  scriptListSchema,
  updateScript,
  updateScriptSchema,
} from './scripts.server'

export const listScriptsFn = createServerFn({ method: 'GET' })
  .validator(scriptListSchema)
  .handler(async ({ data }) => listScripts(await requireUser(), data))

export const describeScriptFn = createServerFn({ method: 'GET' })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }) => describeScriptForOrder(await requireUser(), data.id))

export const createScriptFn = createServerFn({ method: 'POST' })
  .validator(createScriptSchema)
  .handler(async ({ data }) => createScript(await requireUser(), data))

export const updateScriptFn = createServerFn({ method: 'POST' })
  .validator(updateScriptSchema)
  .handler(async ({ data }) => updateScript(await requireUser(), data))

export const copyScriptFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.uuid(), semester: z.string().trim().min(1).max(50) }))
  .handler(async ({ data }) => copyScript(await requireUser(), data))
