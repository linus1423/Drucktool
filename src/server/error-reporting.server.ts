// Optionales Fehler-Tracking mit Sentry oder GlitchTip. Aktiv, sobald SENTRY_DSN gesetzt ist.
// Bewusst ohne SDK: ein Fehler wird als "Envelope" per HTTP an den Dienst geschickt (Sentry-Protokoll, das auch
// GlitchTip versteht). Der Logger ruft reportError() für jeden Fehler-Eintrag mit Fehlerobjekt auf.

export type ErrorContext = { requestId?: string; userId?: string; message?: string }

type Dsn = { url: string; key: string; dsn: string }

type Frame = { function?: string; filename: string; lineno?: number; colno?: number; in_app: boolean }

/** Höchstens so viele Meldungen pro Minute, damit eine Fehlerschleife das Kontingent nicht aufbraucht. */
const MAX_PER_MINUTE = 30
let windowStart = 0
let sentInWindow = 0

/** Zerlegt https://<key>@<host>/<projekt> in die Envelope-Adresse und den Schlüssel. */
export function parseDsn(value: string | undefined): Dsn | null {
  if (!value?.trim()) return null
  try {
    const url = new URL(value.trim())
    const project = url.pathname.split('/').filter(Boolean).pop()
    if (!url.username || !project || !/^https?:$/.test(url.protocol)) return null
    const prefix = url.pathname.slice(0, url.pathname.lastIndexOf(`/${project}`))
    return { url: `${url.protocol}//${url.host}${prefix}/api/${project}/envelope/`, key: url.username, dsn: value.trim() }
  } catch {
    return null
  }
}

/** V8-Stacktrace in Sentry-Frames, ältester Aufruf zuerst. */
export function parseStack(stack: string | undefined): Frame[] {
  if (!stack) return []
  const frames: Frame[] = []
  for (const line of stack.split('\n')) {
    const match = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line)
    if (!match) continue
    const [, fn, filename = '', lineno, colno] = match
    frames.push({
      function: fn,
      filename,
      lineno: Number(lineno),
      colno: Number(colno),
      in_app: !filename.includes('node_modules') && !filename.startsWith('node:'),
    })
  }
  return frames.reverse()
}

function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
}

function exceptionValues(error: unknown, depth = 0): Array<Record<string, unknown>> {
  if (!(error instanceof Error) || depth > 5) return [{ type: 'Error', value: String(error) }]
  const own = {
    type: error.name,
    // Drizzle hängt die Parameter der Abfrage an; sie können Tokens oder Hashes enthalten.
    value: error.message.replace(/\nparams: [\s\S]*$/, '\nparams: [entfernt]'),
    stacktrace: { frames: parseStack(error.stack) },
  }
  // Sentry erwartet die Ursache vor dem Fehler, der sie verpackt.
  return error.cause !== undefined ? [...exceptionValues(error.cause, depth + 1), own] : [own]
}

/** Baut den Envelope (drei JSON-Zeilen) für einen Fehler. */
export function buildEnvelope(error: unknown, context: ErrorContext, dsn: string, now = new Date()) {
  const eventId = randomId()
  const event = {
    event_id: eventId,
    timestamp: now.getTime() / 1000,
    platform: 'node',
    level: 'error',
    logger: 'drucktool',
    release: process.env.APP_VERSION || undefined,
    environment: process.env.APP_ENVIRONMENT || process.env.NODE_ENV || undefined,
    server_name: process.env.HOSTNAME || undefined,
    ...(context.message ? { message: { formatted: context.message } } : {}),
    exception: { values: exceptionValues(error) },
    tags: context.requestId ? { request_id: context.requestId } : undefined,
    user: context.userId ? { id: context.userId } : undefined,
  }
  return [
    JSON.stringify({ event_id: eventId, sent_at: now.toISOString(), dsn }),
    JSON.stringify({ type: 'event' }),
    JSON.stringify(event),
  ].join('\n')
}

/** Schickt den Fehler an Sentry/GlitchTip, falls eingerichtet. Wirft nie und wartet nicht auf die Antwort. */
export function reportError(error: unknown, context: ErrorContext = {}) {
  const dsn = parseDsn(process.env.SENTRY_DSN)
  if (!dsn) return
  const now = Date.now()
  if (now - windowStart > 60_000) {
    windowStart = now
    sentInWindow = 0
  }
  if (++sentInWindow > MAX_PER_MINUTE) return
  try {
    void fetch(dsn.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-sentry-envelope',
        'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${dsn.key}, sentry_client=drucktool/1.0`,
      },
      body: buildEnvelope(error, context, dsn.dsn),
      signal: AbortSignal.timeout(5000),
    })
      .then((res) => {
        if (!res.ok) process.stderr.write(`Fehler-Tracking: Meldung abgelehnt (HTTP ${res.status})\n`)
      })
      .catch(() => process.stderr.write('Fehler-Tracking: Dienst nicht erreichbar\n'))
  } catch {
    // Fehler-Tracking darf die Anwendung nie stören.
  }
}
