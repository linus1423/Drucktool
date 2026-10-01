import { createServerFn } from '@tanstack/react-start'
import { mailLayoutSchema, mailTemplateKeySchema } from '~/lib/mail-templates'
import { z } from 'zod'
import { requireAdmin } from '../auth/guards.server'
import {
  listMailTemplates,
  resetMailTemplate,
  saveMailLayout,
  saveMailTemplate,
  saveMailTemplateSchema,
  sendTestMail,
  testMailSchema,
} from './mail-admin.server'

export const listMailTemplatesFn = createServerFn({ method: 'GET' }).handler(async () => listMailTemplates(await requireAdmin()))

export const saveMailTemplateFn = createServerFn({ method: 'POST' })
  .validator(saveMailTemplateSchema)
  .handler(async ({ data }) => saveMailTemplate(await requireAdmin(), data))

export const resetMailTemplateFn = createServerFn({ method: 'POST' })
  .validator(z.object({ key: mailTemplateKeySchema }))
  .handler(async ({ data }) => resetMailTemplate(await requireAdmin(), data.key))

export const saveMailLayoutFn = createServerFn({ method: 'POST' })
  .validator(mailLayoutSchema)
  .handler(async ({ data }) => saveMailLayout(await requireAdmin(), data))

export const sendTestMailFn = createServerFn({ method: 'POST' })
  .validator(testMailSchema)
  .handler(async ({ data }) => sendTestMail(await requireAdmin(), data))
