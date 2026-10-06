import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { LOGO_KINDS, LOGO_MAX_BYTES, designSchema } from '~/lib/design'
import { requireAdmin } from '../auth/guards.server'
import { getDesignSettings, removeLogo, saveDesign, saveLogo } from './design-admin.server'
import { getLegalText, getPublicDesign } from './design.server'

/** Name, Logo, Farben und Fußzeile für alle Seiten, auch ohne Anmeldung. */
export const getPublicDesignFn = createServerFn({ method: 'GET' }).handler(() => getPublicDesign())

export const getDesignSettingsFn = createServerFn({ method: 'GET' }).handler(async () => getDesignSettings(await requireAdmin()))

export const saveDesignFn = createServerFn({ method: 'POST' })
  .validator(designSchema)
  .handler(async ({ data }) => saveDesign(await requireAdmin(), data))

export const saveLogoFn = createServerFn({ method: 'POST' })
  // Base64 ist rund ein Drittel größer als die Datei.
  .validator(z.object({ kind: z.enum(LOGO_KINDS), data: z.base64().max(Math.ceil((LOGO_MAX_BYTES * 4) / 3) + 4) }))
  .handler(async ({ data }) => saveLogo(await requireAdmin(), data.kind, data.data))

export const removeLogoFn = createServerFn({ method: 'POST' })
  .validator(z.object({ kind: z.enum(LOGO_KINDS) }))
  .handler(async ({ data }) => removeLogo(await requireAdmin(), data.kind))

export const getLegalTextFn = createServerFn({ method: 'GET' })
  .validator(z.object({ page: z.enum(['imprint', 'privacy']) }))
  .handler(({ data }) => getLegalText(data.page))
