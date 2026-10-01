import { and, eq, inArray, isNull, lt } from 'drizzle-orm'
import { isStaffRole } from '~/lib/roles'
import { getDb, schema, type Tx } from '../db/client.server'
import type { Principal } from '../requests/requests.server'
import { analysePdf } from './pdf.server'
import { removeStored, storagePath, storeStream } from './storage.server'

const { requestFiles, requests } = schema

export type FileRole = 'main' | 'cover'

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
  const stored = await storeStream(input.body)
  if (stored.sizeBytes === 0) {
    await removeStored(stored.key)
    throw new EmptyUploadError()
  }
  try {
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

export async function cleanupOrphans(now = Date.now()) {
  const rows = await getDb()
    .delete(requestFiles)
    .where(and(isNull(requestFiles.requestId), lt(requestFiles.createdAt, new Date(now - ORPHAN_MAX_AGE_MS))))
    .returning({ key: requestFiles.storageKey })
  await Promise.all(rows.map((r) => removeStored(r.key)))
  return rows.length
}

/** Datei für den Download: Mitarbeiter immer, Kunden nur eigene Uploads und Dateien eigener Aufträge. */
export async function fileForDownload(user: Principal, id: string) {
  const [row] = await getDb()
    .select({ file: requestFiles, requestCreatorId: requests.createdById })
    .from(requestFiles)
    .leftJoin(requests, eq(requests.id, requestFiles.requestId))
    .where(eq(requestFiles.id, id))
  if (!row) return null
  const allowed = isStaffRole(user.role) || (row.file.requestId ? row.requestCreatorId === user.id : row.file.ownerId === user.id)
  return allowed ? row.file : null
}

/**
 * Ordnet beim Absenden die hochgeladenen Dateien dem Auftrag zu. Nur eigene,
 * noch nicht verwendete Uploads mit passender Rolle werden akzeptiert.
 */
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

export async function listRequestFiles(requestId: string) {
  const rows = await getDb()
    .select()
    .from(requestFiles)
    .where(eq(requestFiles.requestId, requestId))
    .orderBy(requestFiles.createdAt)
  return rows.map(publicFile)
}
