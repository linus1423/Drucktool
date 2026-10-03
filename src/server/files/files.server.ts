import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { isStaffRole } from '~/lib/roles'
import { getDb, schema, type Tx } from '../db/client.server'
import { managedOrganisationIds } from '../organisations/org-admin.server'
import { svkOrganisationIds } from '../scripts/scripts.server'
import type { Principal } from '../requests/requests.server'
import { writeAudit } from '../audit/audit.server'
import { logger } from '../log.server'
import { purgeUnsubmittedUploads } from '../maintenance/cleanup.server'
import { analysePdf } from './pdf.server'
import {
  maxAttachmentBytes,
  maxPendingUploadBytes,
  maxUploadBytes,
  openStored,
  removeStored,
  storagePath,
  storeStream,
  UploadTooLargeError,
} from './storage.server'
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

export class PendingUploadsFullError extends Error {
  constructor() {
    super(
      'Sie haben zu viele noch nicht abgeschickte Dateien hochgeladen. Bitte schicken Sie den Auftrag ab oder versuchen Sie es morgen erneut.',
    )
  }
}

/** Platz, der dem Benutzer für weitere, noch nicht abgeschickte Uploads bleibt (Issue #140). */
async function pendingUploadRoom(userId: string) {
  const [row] = await getDb()
    .select({ bytes: sql<string>`coalesce(sum(${requestFiles.sizeBytes}), 0)` })
    .from(requestFiles)
    .where(and(eq(requestFiles.ownerId, userId), isNull(requestFiles.requestId)))
  const room = maxPendingUploadBytes() - Number(row?.bytes ?? 0)
  if (room <= 0) throw new PendingUploadsFullError()
  return room
}

/** Speichert mit dem kleineren der beiden Limits; reißt erst das Kontingent, kommt dessen Meldung. */
async function storeWithinRoom(body: Parameters<typeof storeStream>[0], limit: number, room: number) {
  try {
    return await storeStream(body, Math.min(limit, room))
  } catch (e) {
    if (e instanceof UploadTooLargeError && room < limit) throw new PendingUploadsFullError()
    throw e
  }
}

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
    // Nach Ablauf der Löschfrist entfernt (Issue #172): dann gibt es nichts mehr herunterzuladen.
    purgedAt: row.purgedAt,
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
  const stored = await storeWithinRoom(input.body, uploadLimit(input.role), await pendingUploadRoom(user.id))
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

/** Räumt nie abgeschickte Uploads ab (UNSUBMITTED_UPLOAD_RETENTION_DAYS); läuft auch stündlich im Worker. */
export async function cleanupOrphans() {
  return purgeUnsubmittedUploads(getDb())
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
  if (managed) return row.file
  // Druckdaten von SVK-Aufträgen sieht die ganze SVK (Issue #59).
  const svk = await svkOrganisationIds(getDb(), user.id)
  return svk.some((o) => o.id === row.requestOrganisationId) ? row.file : null
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
  if (source.purgedAt) throw new Error('Die Datei wurde nach Ablauf der Löschfrist gelöscht. Bitte neu hochladen.')
  // Der Wizard lädt die Vorlage bei jedem Öffnen neu: eine schon vorhandene, freie Kopie wiederverwenden (Issue #140).
  const [free] = await getDb()
    .select({ id: requestFiles.id })
    .from(requestFiles)
    .where(
      and(
        eq(requestFiles.ownerId, user.id),
        isNull(requestFiles.requestId),
        eq(requestFiles.role, source.role),
        eq(requestFiles.sha256, source.sha256),
        eq(requestFiles.filename, source.filename),
      ),
    )
    .limit(1)
  // Frisch datiert, damit das Aufräumen sie nicht löscht, während der Wizard offen ist.
  const [existing] = free
    ? await getDb()
        .update(requestFiles)
        .set({ createdAt: new Date() })
        .where(and(eq(requestFiles.id, free.id), isNull(requestFiles.requestId)))
        .returning()
    : []
  if (existing) return publicFile(existing)
  const stored = await storeWithinRoom(openStored(source.storageKey), Number.MAX_SAFE_INTEGER, await pendingUploadRoom(user.id))
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

/**
 * Dateien eines im Browser gespeicherten Entwurfs (Issue #175): nur eigene, noch nicht abgeschickte Uploads mit
 * passender Rolle. Sie werden frisch datiert, damit das Aufräumen sie nicht löscht, während der Assistent offen ist.
 */
export async function draftFiles(user: Principal, ids: { main: string | null; cover: string | null }) {
  const wanted = [ids.main, ids.cover].filter((id): id is string => !!id)
  if (wanted.length === 0) return { main: null, cover: null }
  const rows = await getDb()
    .update(requestFiles)
    .set({ createdAt: new Date() })
    .where(and(inArray(requestFiles.id, wanted), eq(requestFiles.ownerId, user.id), isNull(requestFiles.requestId)))
    .returning()
  const main = rows.find((r) => r.id === ids.main && r.role === 'main')
  const cover = rows.find((r) => r.id === ids.cover && r.role === 'cover')
  return { main: main ? publicFile(main) : null, cover: cover ? publicFile(cover) : null }
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
  // In der Reihenfolge, in der sie angehängt wurden; Postgres liefert ohne ORDER BY beliebig.
  return rows.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)).map(publicFile)
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
