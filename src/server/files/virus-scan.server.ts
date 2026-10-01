// Virenprüfung hochgeladener Dateien mit ClamAV (Issue #99). Die App schickt die Datei per TCP an clamd
// (Protokoll INSTREAM), es braucht also kein ClamAV im App-Image. Aktiv, sobald CLAMAV_HOST gesetzt ist.
import { createReadStream } from 'node:fs'
import net from 'node:net'

export type ScanResult = { status: 'clean' } | { status: 'infected'; signature: string } | { status: 'skipped' }

export class VirusFoundError extends Error {
  constructor(readonly signature: string) {
    super(`Die Datei enthält Schadsoftware (${signature}) und wurde nicht angenommen.`)
  }
}

export class VirusScanUnavailableError extends Error {
  constructor(readonly reason: string) {
    super('Die Virenprüfung ist gerade nicht erreichbar. Bitte versuchen Sie es in ein paar Minuten erneut.')
  }
}

export function virusScanConfig() {
  const host = process.env.CLAMAV_HOST?.trim()
  if (!host) return null
  const port = Number(process.env.CLAMAV_PORT || 3310)
  const timeoutSeconds = Number(process.env.CLAMAV_TIMEOUT_SECONDS || 300)
  return {
    host,
    port: Number.isInteger(port) && port > 0 ? port : 3310,
    timeoutMs: (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 300) * 1000,
  }
}

/** Antwort von clamd auswerten, z. B. "stream: OK" oder "stream: Eicar-Signature FOUND". */
export function parseClamdReply(reply: string): ScanResult {
  const text = reply.replace(/\0/g, '').trim()
  if (/^stream: OK$/.test(text)) return { status: 'clean' }
  const found = /^stream: (.+) FOUND$/.exec(text)
  if (found) return { status: 'infected', signature: found[1]! }
  throw new VirusScanUnavailableError(text || 'leere Antwort')
}

/**
 * Prüft eine gespeicherte Datei. Ohne CLAMAV_HOST wird nichts geprüft ("skipped"). Ist clamd eingerichtet, aber
 * nicht erreichbar, wird der Upload abgelehnt: lieber später erneut hochladen als ungeprüft annehmen.
 */
export async function scanFile(path: string): Promise<ScanResult> {
  const config = virusScanConfig()
  if (!config) return { status: 'skipped' }

  const socket = net.connect({ host: config.host, port: config.port })
  socket.setTimeout(config.timeoutMs)
  const reply = new Promise<string>((resolve, reject) => {
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      data += chunk
      if (data.includes('\0')) {
        resolve(data)
        socket.end()
      }
    })
    socket.on('end', () => resolve(data))
    socket.on('timeout', () => socket.destroy(new Error('Zeitüberschreitung')))
    socket.on('error', reject)
  })
  // Schlägt das Senden fehl, kommt der Fehler auch über reply; so bleibt kein Promise unbehandelt.
  reply.catch(() => {})

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    await write(socket, Buffer.from('zINSTREAM\0'))
    for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
      const header = Buffer.alloc(4)
      header.writeUInt32BE((chunk as Buffer).length)
      await write(socket, header)
      await write(socket, chunk as Buffer)
    }
    await write(socket, Buffer.alloc(4))
    return parseClamdReply(await reply)
  } catch (e) {
    socket.destroy()
    if (e instanceof VirusScanUnavailableError) throw e
    // clamd beendet die Verbindung vorzeitig, wenn die Datei StreamMaxLength überschreitet. Meist ist seine Antwort
    // dann schon da, sonst bleibt nur der Schreibfehler.
    const early = (await reply.catch(() => '')).replace(/\0/g, '').trim()
    const code = (e as NodeJS.ErrnoException).code
    const hint = code === 'EPIPE' || code === 'ECONNRESET' ? ' (clamd hat abgebrochen, StreamMaxLength zu klein?)' : ''
    throw new VirusScanUnavailableError(early || `${(e as Error).message}${hint}`)
  }
}

function write(socket: net.Socket, data: Buffer) {
  return new Promise<void>((resolve, reject) => {
    socket.write(data, (err) => (err ? reject(err) : resolve()))
  })
}
