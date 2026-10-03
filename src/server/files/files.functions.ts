import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from '../auth/guards.server'
import { draftFiles } from './files.server'

/** Prüft die Dateien eines wiederhergestellten Entwurfs im Bestell-Assistenten (Issue #175). */
export const draftFilesFn = createServerFn({ method: 'POST' })
  .validator(z.object({ main: z.uuid().nullable(), cover: z.uuid().nullable() }))
  .handler(async ({ data }) => draftFiles(await requireUser(), data))
