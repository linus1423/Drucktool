import { AsyncLocalStorage } from 'node:async_hooks'
import { reportError } from './error-reporting.server'

// Schlanker Logger: eine JSON-Zeile pro Eintrag (in Produktion), lesbarer Text in der Entwicklung.
// LOG_LEVEL: debug, info (Standard), warn, error. LOG_FORMAT: json oder text.
// Fehler-Einträge mit Fehlerobjekt (Feld err) gehen zusätzlich an Sentry/GlitchTip, wenn SENTRY_DSN gesetzt ist.

type Level = 'debug' | 'info' | 'warn' | 'error'
type Fields = Record<string, unknown>

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Daten der laufenden Anfrage, werden automatisch an jeden Logeintrag gehängt. */
export type RequestContext = { requestId: string; userId?: string }
export const requestContext = new AsyncLocalStorage<RequestContext>()

/** Felder, deren Werte nie im Log landen dürfen. */
const SECRET_KEY = /pass|token|secret|authorization|cookie|hash/i

function minLevel(): number {
  const level = process.env.LOG_LEVEL as Level | undefined
  return LEVELS[level ?? 'info'] ?? LEVELS.info
}

function useJson(): boolean {
  const format = process.env.LOG_FORMAT
  if (format) return format === 'json'
  return process.env.NODE_ENV === 'production'
}

export function serializeError(error: unknown): Fields {
  if (!(error instanceof Error)) return { message: String(error) }
  const code = (error as { code?: unknown }).code
  return {
    name: error.name,
    // Drizzle hängt die Parameter der Abfrage an die Meldung; sie können Tokens oder Hashes enthalten.
    message: error.message.replace(/\nparams: [\s\S]*$/, '\nparams: [entfernt]'),
    ...(code !== undefined ? { code } : {}),
    stack: error.stack?.replace(/\nparams: [\s\S]*?(?=\n\s+at |$)/, '\nparams: [entfernt]'),
    ...(error.cause !== undefined ? { cause: serializeError(error.cause) } : {}),
  }
}

/** Technische Fehler (Datenbank, Netzwerk, Programmierfehler), deren Text Nutzer nicht sehen sollen. */
export function isUnexpectedError(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error) || depth > 5) return false
  if (['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'PostgresError'].includes(error.name)) return true
  // Drizzle verpackt Datenbankfehler ("Failed query: …") und hängt den eigentlichen Fehler als cause an.
  if (error.constructor.name === 'DrizzleQueryError' || error.message.startsWith('Failed query:')) return true
  // Systemfehler (ECONNREFUSED, …) und Datenbankfehler haben einen Code.
  if (typeof (error as { code?: unknown }).code === 'string') return true
  return isUnexpectedError(error.cause, depth + 1)
}

function clean(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return serializeError(value)
  if (value === null || typeof value !== 'object' || depth > 3) return value
  if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1))
  if (value instanceof Date) return value.toISOString()
  const out: Fields = {}
  for (const [key, v] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? '[entfernt]' : clean(v, depth + 1)
  }
  return out
}

function write(level: Level, msg: string, fields?: Fields) {
  if (LEVELS[level] < minLevel()) return
  const ctx = requestContext.getStore()
  if (level === 'error' && fields?.err !== undefined) reportError(fields.err, { ...ctx, message: msg })
  const entry = { time: new Date().toISOString(), level, msg, ...ctx, ...(clean(fields ?? {}) as Fields) }
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout
  if (useJson()) {
    stream.write(`${JSON.stringify(entry)}\n`)
    return
  }
  const { time, level: _l, msg: _m, err, ...rest } = entry as Fields
  const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : ''
  const stack = err && typeof err === 'object' && 'stack' in err ? `\n${String((err as Fields).stack)}` : ''
  stream.write(`${String(time).slice(11, 19)} ${level.toUpperCase().padEnd(5)} ${msg}${extra}${stack}\n`)
}

export const logger = {
  debug: (msg: string, fields?: Fields) => write('debug', msg, fields),
  info: (msg: string, fields?: Fields) => write('info', msg, fields),
  warn: (msg: string, fields?: Fields) => write('warn', msg, fields),
  error: (msg: string, fields?: Fields) => write('error', msg, fields),
}
