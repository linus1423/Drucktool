// Liest Seitenzahl und Seitengröße aus einer PDF. Scheitert das, wird die Datei
// trotzdem angenommen (Lastenheft 8) und nur markiert.
import { existsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { fork } from 'node:child_process'
import { logger } from '../log.server'

export type PdfInfo = {
  status: 'ok' | 'encrypted' | 'unreadable' | 'not_pdf'
  pageCount: number | null
  pageWidthMm: number | null
  pageHeightMm: number | null
  mixedPageSizes: boolean
}

/** Größere Dateien werden nicht geparst; der Kunde gibt die Seitenzahl dann selbst an. */
const ANALYSE_MAX_BYTES = 150 * 1024 * 1024
/** Gleichzeitige Auswertungen; weitere warten, damit viele Uploads den Server nicht auslasten. */
const MAX_PARALLEL = 2

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

async function hasPdfHeader(file: string) {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(1024)
    const { bytesRead } = await handle.read(buffer, 0, 1024, 0)
    return buffer.subarray(0, bytesRead).includes('%PDF-')
  } finally {
    await handle.close()
  }
}

const empty = (status: PdfInfo['status']): PdfInfo => ({
  status,
  pageCount: null,
  pageWidthMm: null,
  pageHeightMm: null,
  mixedPageSizes: false,
})

/** Gebündeltes Skript neben dem Server (pnpm build), sonst die Quelldatei (Entwicklung, Tests). */
function workerPath() {
  const candidates = [
    process.env.PDF_WORKER_PATH,
    path.resolve(path.dirname(process.argv[1] ?? ''), '../scripts/pdf-worker.mjs'),
    path.resolve('src/server/files/pdf-worker.ts'),
    path.resolve('.output/scripts/pdf-worker.mjs'),
  ]
  return candidates.find((file): file is string => !!file && existsSync(file)) ?? null
}

let running = 0
const waiting: (() => void)[] = []

async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve))
  running++
  try {
    return await task()
  } finally {
    running--
    waiting.shift()?.()
  }
}

/**
 * Parst die PDF in einem eigenen Node-Prozess mit Zeit- und Speicherlimit. Eine präparierte Datei kann
 * so weder die App blockieren noch ihren Speicher aufbrauchen; sie gilt dann nur als nicht lesbar.
 * Ein Prozess statt eines Worker-Threads, weil Node die Speichergrenzen von Threads nicht zuverlässig
 * durchsetzt. Der Prozess bekommt keine Umgebungsvariablen, also auch keine Zugangsdaten.
 */
function analyseInWorker(file: string): Promise<PdfInfo> {
  const script = workerPath()
  if (!script) {
    logger.error('PDF-Auswertung nicht möglich: pdf-worker nicht gefunden')
    return Promise.resolve(empty('unreadable'))
  }
  const timeoutMs = numberEnv('PDF_ANALYSE_TIMEOUT_SECONDS', 60) * 1000
  return new Promise((resolve) => {
    const worker = fork(script, [file], {
      execArgv: [`--max-old-space-size=${numberEnv('PDF_ANALYSE_MAX_MEMORY_MB', 1024)}`],
      env: {},
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'json',
    })
    let settled = false
    const finish = (info: PdfInfo) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.kill('SIGKILL')
      resolve(info)
    }
    const timer = setTimeout(() => {
      logger.warn('PDF-Auswertung abgebrochen: Zeitlimit überschritten', { timeoutMs })
      finish(empty('unreadable'))
    }, timeoutMs)
    worker.once('message', (info: PdfInfo | null) => finish(info ?? empty('unreadable')))
    worker.once('error', (err) => {
      logger.warn('PDF-Auswertung fehlgeschlagen', { err })
      finish(empty('unreadable'))
    })
    worker.once('exit', () => finish(empty('unreadable')))
  })
}

export async function analysePdf(file: string, sizeBytes: number): Promise<PdfInfo> {
  if (!(await hasPdfHeader(file))) return empty('not_pdf')
  if (sizeBytes > ANALYSE_MAX_BYTES) return empty('unreadable')
  return limited(() => analyseInWorker(file))
}
