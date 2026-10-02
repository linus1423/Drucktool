import { createMiddleware } from '@tanstack/react-start'
import { isUnexpectedError, logger, requestContext } from './log.server'

const REQUEST_ID = /^[\w.-]{1,64}$/

function newRequestId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function isClientAbort(request: Request, error: unknown) {
  if (request.signal.aborted) return true
  // Node meldet den Abbruch als Error('aborted') mit code ECONNRESET, h3 verpackt ihn manchmal noch einmal.
  for (let e = error as { code?: unknown; message?: unknown; cause?: unknown } | null, i = 0; e && i < 3; i++) {
    if (e.code === 'ECONNRESET' && e.message === 'aborted') return true
    e = e.cause as typeof e
  }
  return false
}

/** Pfade mit geheimen Tokens, die nicht im Log landen dürfen (Einladungslinks, Issue #132). */
const SECRET_PATHS = [/^(\/einladung\/)[^/]+/]

/** Pfad fürs Log: geheime Teile werden durch „…“ ersetzt. */
export function loggedPath(pathname: string) {
  return SECRET_PATHS.reduce((path, pattern) => path.replace(pattern, '$1…'), pathname)
}

/** Vergibt jeder Anfrage eine Request-ID und protokolliert Methode, Pfad, Status und Dauer. */
export const requestLogMiddleware = createMiddleware().server(async ({ request, pathname, next }) => {
  const incoming = request.headers.get('x-request-id')
  const ctx = { requestId: incoming && REQUEST_ID.test(incoming) ? incoming : newRequestId() }
  const start = performance.now()
  return requestContext.run(ctx, async () => {
    try {
      const result = await next()
      const status = result.response.status
      const fields = {
        method: request.method,
        path: loggedPath(pathname),
        status,
        durationMs: Math.round(performance.now() - start),
      }
      // Healthchecks kommen alle 30 Sekunden und interessieren nur im Fehlerfall.
      if (status >= 500) logger.error('Anfrage fehlgeschlagen', fields)
      else if (pathname === '/api/health') logger.debug('Anfrage', fields)
      else logger.info('Anfrage', fields)
      try {
        result.response.headers.set('x-request-id', ctx.requestId)
      } catch {
        // Manche Antworten haben unveränderliche Header.
      }
      return result
    } catch (error) {
      const fields = { method: request.method, path: loggedPath(pathname), durationMs: Math.round(performance.now() - start) }
      // Schließt der Browser die Verbindung vorzeitig (Seite verlassen, Neu laden), ist das kein Fehler der App.
      if (isClientAbort(request, error)) logger.info('Verbindung vom Browser abgebrochen', fields)
      else logger.error('Unbehandelter Fehler', { ...fields, err: error })
      throw error
    }
  })
})

/**
 * Technische Fehler (Datenbank, Programmierfehler) landen mit Stacktrace im Log; der Nutzer sieht nur eine
 * allgemeine Meldung mit Fehlernummer. Fachliche Fehler (`throw new Error('…')` mit Text für den Nutzer) bleiben.
 */
export const errorMiddleware = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  try {
    return await next()
  } catch (error) {
    if (!isUnexpectedError(error)) throw error
    const requestId = requestContext.getStore()?.requestId
    logger.error('Unerwarteter Fehler in einer Server-Funktion', { err: error })
    throw new Error(
      `Es ist ein unerwarteter Fehler aufgetreten. Bitte versuchen Sie es später erneut${requestId ? ` (Fehlernummer ${requestId})` : ''}.`,
    )
  }
})
