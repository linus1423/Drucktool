import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import { isStaffRole } from '~/lib/roles'
import { getDb, schema, type Tx } from '../db/client.server'
import { managedOrganisationIds } from '../organisations/org-admin.server'
import type { Principal } from '../requests/requests.server'
import { writeAudit } from '../audit/audit.server'
import { logger } from '../log.server'
import { analysePdf } from './pdf.server'
import { maxAttachmentBytes, maxUploadBytes, openStored, removeStored, storagePath, storeStream } from './storage.server'
import { scanFile, VirusFoundError, VirusScanUnavailableError } from './virus-scan.server'

const { requestFiles, requests, requestComments } = schema

export type FileRole = 'main' | 'cover' | 'attachment'

export const MAX_ATTACHMENTS = 10

const DEFAULT_ATTACHMENT_TYPES = 'pdf,png,jpg,jpeg,gif,webp,tif,tiff,svg,eps,ai,psd,txt,csv,docx,xlsx,pptx,odt,ods,zip'

/** Erlaubte Dateiendungen für Anhänge, per ATTACHMENT_TYPES anpassbar (kommagetrennt). */
export function attachmentTypes() {
  return (process.env.ATTACHMENT_TYPES || DEFAULT_ATTACHMENT_TYPES)
    .split(',')
    .map((t) => t.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean)
}

export class AttachmentTypeError extends Error {
  constructor() {
    super(`Dieser Dateityp ist als Anhang nicht erlaubt. Erlaubt: ${attachmentTypes().join(', ')}.`)
  }
}

export function uploadLimit(role: FileRole) {
  return role === 'attachment' ? maxAttachmentBytes() : maxUploadBytes()
}

export class EmptyUploadError extends Error {
  constructor() {
    super('Die Datei ist leer.')
  }
}

/** Nicht abgeschickte Uploads werden nach einem Tag gelöscht. */
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000

export function publicFile(row: typeof requestFiles.$inferSelect) {
  return {
    id: row.id,
    role: row.role,
    filename: row.filename,
    sizeBytes: row.sizeBytes,
    pdfStatus: row.pdfStatus,
    pageCount: row.pageCount,
    pageWidthMm: row.pageWidthMm,
    pageHeightMm: row.pageHeightMm,
    mixedPageSizes: row.mixedPageSizes,
    createdAt: row.createdAt,
  }
}
export type PublicFile = ReturnType<typeof publicFile>

/** Dateiname ohne Pfadanteile und Steuerzeichen, höchstens 200 Zeichen. */
export function cleanFilename(name: string) {
  const base = name.split(/[\\/]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim()
  return (cleaned || 'datei.pdf').slice(0, 200)
}

export async function createUpload(
  user: Principal,
  input: { role: FileRole; filename: string; mimeType: string; body: AsyncIterable<Uint8Array> | NodeJS.ReadableStream },
) {
  await cleanupOrphans()
  if (input.role === 'attachment') {
    const ext = input.filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
    if (!ext || !attachmentTypes().includes(ext)) throw new AttachmentTypeError()
  }
  const stored = await storeStream(input.body, uploadLimit(input.role))
  if (stored.sizeBytes === 0) {
    await removeStored(stored.key)
    throw new EmptyUploadError()
  }
  try {
    // Erst auf Schadsoftware prüfen, dann die PDF auswerten (Issue #99).
    await assertNoVirus(user, stored.key, input.filename)
    const info = await analysePdf(storagePath(stored.key), stored.sizeBytes)
    const [row] = await getDb()
      .insert(requestFiles)
      .values({
        ownerId: user.id,
        role: input.role,
        filename: cleanFilename(input.filename),
        sizeBytes: stored.sizeBytes,
        mimeType: info.status === 'not_pdf' ? input.mimeType.slice(0, 100) || 'application/octet-stream' : 'application/pdf',
        sha256: stored.sha256,
        storageKey: stored.key,
        pdfStatus: info.status,
        pageCount: info.pageCount,
        pageWidthMm: info.pageWidthMm,
        pageHeightMm: info.pageHeightMm,
        mixedPageSizes: info.mixedPageSizes,
      })
      .returning()
    return publicFile(row!)
  } catch (e) {
    await removeStored(stored.key)
    throw e
  }
}

async function assertNoVirus(user: Principal, key: string, filename: string) {
  let result
  try {
    result = await scanFile(storagePath(key))
  } catch (e) {
    if (e instanceof VirusScanUnavailableError) logger.error('Virenprüfung nicht möglich', { reason: e.reason })
    throw e
  }
  if (result.status !== 'infected') return
  logger.warn('Schadsoftware in Upload gefunden', { userId: user.id, signature: result.signature })
  await writeAudit(getDb(), {
    actorId: user.id,
    action: 'file.virus_found',
    targetType: 'user',
    targetId: user.id,
    data: { filename: cleanFilename(filename), signature: result.signature },
  })
  throw new VirusFoundError(result.signature)
}

export async function cleanupOrphans(now = Date.now()) {
  const rows = await getDb()
    .delete(requestFiles)
    .where(and(isNull(requestFiles.requestId), lt(requestFiles.createdAt, new Date(now - ORPHAN_MAX_AGE_MS))))
    .returning({ key: requestFiles.storageKey })
  await Promise.all(rows.map((r) => removeStored(r.key)))
  return rows.length
}

/**
 * Datei für den Download: Mitarbeiter immer, Kunden nur eigene Uploads, Dateien eigener Aufträge und Dateien von
 * Aufträgen der Organisationen, die sie verwalten (Issue #12).
 */
export async function fileForDownload(user: Principal, id: string) {
  const [row] = await getDb()
    .select({
      file: requestFiles,
      requestCreatorId: requests.createdById,
      requestOrganisationId: requests.organisationId,
      commentInternal: requestComments.internal,
    })
    .from(requestFiles)
    .leftJoin(requests, eq(requests.id, requestFiles.requestId))
    .leftJoin(requestComments, eq(requestComments.id, requestFiles.commentId))
    .where(eq(requestFiles.id, id))
  if (!row) return null
  if (isStaffRole(user.role)) return row.file
  // Anhänge interner Notizen sind für Kunden tabu, auch am eigenen Auftrag.
  if (row.commentInternal) return null
  if (!row.file.requestId) return row.file.ownerId === user.id ? row.file : null
  if (row.requestCreatorId === user.id) return row.file
  if (!row.requestOrganisationId) return null
  const [managed] = await managedOrganisationIds(getDb(), user.id, row.requestOrganisationId)
  return managed ? row.file : null
}

/**
 * Ordnet beim Absenden die hochgeladenen Dateien dem Auftrag zu. Nur eigene,
 * noch nicht verwendete Uploads mit passender Rolle werden akzeptiert.
 */
/**
 * Kopiert eine Datei eines früheren Auftrags als neuen, noch nicht zugeordneten Upload (Nachbestellung).
 * Die Kopie liegt getrennt auf der Platte, damit das Löschen eines Auftrags die andere nicht berührt.
 */
export async function copyAsUpload(user: Principal, source: typeof requestFiles.$inferSelect) {
  const stored = await storeStream(openStored(source.storageKey), Number.MAX_SAFE_INTEGER)
  try {
    const { id: _id, requestId: _r, ownerId: _o, storageKey: _k, createdAt: _c, ...rest } = source
    const [row] = await getDb()
      .insert(requestFiles)
      .values({ ...rest, ownerId: user.id, storageKey: stored.key, sha256: stored.sha256, sizeBytes: stored.sizeBytes })
      .returning()
    return publicFile(row!)
  } catch (e) {
    await removeStored(stored.key)
    throw e
  }
}

export async function claimFiles(tx: Tx, user: Principal, requestId: string, ids: { main: string; cover: string | null }) {
  const wanted = [ids.main, ...(ids.cover ? [ids.cover] : [])]
  const rows = await tx
    .select()
    .from(requestFiles)
    .where(and(inArray(requestFiles.id, wanted), eq(requestFiles.ownerId, user.id), isNull(requestFiles.requestId)))
    .for('update')
  const main = rows.find((r) => r.id === ids.main && r.role === 'main')
  const cover = ids.cover ? rows.find((r) => r.id === ids.cover && r.role === 'cover') : null
  if (!main) throw new Error('Die Druckdatei wurde nicht gefunden. Bitte erneut hochladen.')
  if (ids.cover && !cover) throw new Error('Die Deckblatt-Datei wurde nicht gefunden. Bitte erneut hochladen.')
  await tx.update(requestFiles).set({ requestId }).where(inArray(requestFiles.id, wanted))
  return { main, cover: cover ?? null }
}

/** Druck- und Deckblattdateien eines Auftrags; Anhänge hängen an ihren Nachrichten. */
export async function listRequestFiles(requestId: string) {
  const rows = await getDb()
    .select()
    .from(requestFiles)
    .where(and(eq(requestFiles.requestId, requestId), or(eq(requestFiles.role, 'main'), eq(requestFiles.role, 'cover'))))
    .orderBy(requestFiles.createdAt)
  return rows.map(publicFile)
}

/** Ordnet hochgeladene Anhänge einer Nachricht zu. Nur eigene, noch freie Anhänge. */
export async function claimAttachments(tx: Tx, user: Principal, requestId: string, commentId: string, ids: string[]) {
  if (ids.length === 0) return []
  const rows = await tx
    .select()
    .from(requestFiles)
    .where(
      and(
        inArray(requestFiles.id, ids),
        eq(requestFiles.ownerId, user.id),
        eq(requestFiles.role, 'attachment'),
        isNull(requestFiles.requestId),
      ),
    )
    .for('update')
  if (rows.length !== new Set(ids).size) throw new Error('Ein Anhang wurde nicht gefunden. Bitte erneut hochladen.')
  await tx.update(requestFiles).set({ requestId, commentId }).where(inArray(requestFiles.id, ids))
  return rows.map(publicFile)
}

export async function listCommentAttachments(commentIds: string[]) {
  if (commentIds.length === 0) return new Map<string, PublicFile[]>()
  const rows = await getDb()
    .select()
    .from(requestFiles)
    .where(inArray(requestFiles.commentId, commentIds))
    .orderBy(requestFiles.createdAt)
  const map = new Map<string, PublicFile[]>()
  for (const r of rows) map.set(r.commentId!, [...(map.get(r.commentId!) ?? []), publicFile(r)])
  return map
}
