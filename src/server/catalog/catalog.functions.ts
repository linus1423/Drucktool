import { createServerFn } from '@tanstack/react-start'
import { bindingUpdateSchema, coverColorSchema, formatUpdateSchema, paperSchema, pricingSchema, textsSchema } from '~/lib/catalog'
import { deadlineSettingsSchema } from '~/lib/deadlines'
import { requireAdmin, requireUser } from '../auth/guards.server'
import {
  formatBindingSchema,
  getCatalog,
  getDeadlineSettings,
  saveDeadlineSettings,
  listCatalogChanges,
  saveCoverColor,
  savePaper,
  savePricing,
  saveTexts,
  setFormatBinding,
  updateBinding,
  updateFormat,
} from './catalog.server'

/** Katalog für den Auftrags-Wizard: nur verfügbare Optionen. */
export const getOrderCatalogFn = createServerFn({ method: 'GET' }).handler(async () => {
  await requireUser()
  return getCatalog({ onlyAvailable: true })
})

export const getAdminCatalogFn = createServerFn({ method: 'GET' }).handler(async () => {
  await requireAdmin()
  const [catalog, deadlines] = await Promise.all([getCatalog(), getDeadlineSettings()])
  return { ...catalog, deadlines }
})

export const saveDeadlineSettingsFn = createServerFn({ method: 'POST' })
  .validator(deadlineSettingsSchema)
  .handler(async ({ data }) => saveDeadlineSettings(await requireAdmin(), data))

export const listCatalogChangesFn = createServerFn({ method: 'GET' }).handler(async () => {
  await requireAdmin()
  return listCatalogChanges()
})

export const updateFormatFn = createServerFn({ method: 'POST' })
  .validator(formatUpdateSchema)
  .handler(async ({ data }) => updateFormat(await requireAdmin(), data))

export const updateBindingFn = createServerFn({ method: 'POST' })
  .validator(bindingUpdateSchema)
  .handler(async ({ data }) => updateBinding(await requireAdmin(), data))

export const setFormatBindingFn = createServerFn({ method: 'POST' })
  .validator(formatBindingSchema)
  .handler(async ({ data }) => setFormatBinding(await requireAdmin(), data))

export const savePaperFn = createServerFn({ method: 'POST' })
  .validator(paperSchema)
  .handler(async ({ data }) => savePaper(await requireAdmin(), data))

export const saveCoverColorFn = createServerFn({ method: 'POST' })
  .validator(coverColorSchema)
  .handler(async ({ data }) => saveCoverColor(await requireAdmin(), data))

export const savePricingFn = createServerFn({ method: 'POST' })
  .validator(pricingSchema)
  .handler(async ({ data }) => savePricing(await requireAdmin(), data))

export const saveTextsFn = createServerFn({ method: 'POST' })
  .validator(textsSchema)
  .handler(async ({ data }) => saveTexts(await requireAdmin(), data))
