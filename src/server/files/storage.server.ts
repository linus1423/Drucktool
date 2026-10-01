// Ablage der Druckdaten im Dateisystem (Docker-Volume). Dateien sind nie öffentlich
// erreichbar, ausgeliefert wird nur über /api/dateien nach Rechteprüfung.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export function uploadDir() {
  return path.resolve(process.env.UPLOAD_DIR || 'data/uploads')
}

/** Höchstgröße pro Datei in Bytes (UPLOAD_MAX_MB, Standard 500 MB für große Plots). */
export function maxUploadBytes() {
  const mb = Number(process.env.UPLOAD_MAX_MB || 500)
  return (Number.isFinite(mb) && mb > 0 ? mb : 500) * 1024 * 1024
}

export class UploadTooLargeError extends Error {
  constructor(limit: number) {
    super(`Die Datei ist zu groß (höchstens ${Math.round(limit / 1024 / 1024)} MB).`)
  }
}

export function storagePath(key: string) {
  // Schlüssel werden nur hier erzeugt; der Check schützt trotzdem vor Pfaden außerhalb des Verzeichnisses.
  const full = path.resolve(uploadDir(), key)
  if (!full.startsWith(uploadDir() + path.sep)) throw new Error('Ungültiger Speicherpfad')
  return full
}

/** Schreibt einen Stream in eine neue Datei, prüft dabei die Größe und berechnet SHA-256. */
export async function storeStream(source: AsyncIterable<Uint8Array> | NodeJS.ReadableStream, limit = maxUploadBytes()) {
  const now = new Date()
  const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}`
  const target = storagePath(key)
  const temp = `${target}.part`
  await mkdir(path.dirname(target), { recursive: true })

  const hash = createHash('sha256')
  let size = 0
  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length
      if (size > limit) return done(new UploadTooLargeError(limit))
      hash.update(chunk)
      done(null, chunk)
    },
  })
  try {
    await pipeline(source, meter, createWriteStream(temp, { flags: 'wx', mode: 0o640 }))
    await rename(temp, target)
  } catch (e) {
    await rm(temp, { force: true })
    throw e
  }
  return { key, sizeBytes: size, sha256: hash.digest('hex') }
}

export function openStored(key: string) {
  return createReadStream(storagePath(key))
}

export async function storedSize(key: string) {
  return (await stat(storagePath(key))).size
}

export async function removeStored(key: string) {
  await rm(storagePath(key), { force: true })
}
