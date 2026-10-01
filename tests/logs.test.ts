import { afterEach, describe, expect, it, vi } from 'vitest'
import { isUnexpectedError, logger, requestContext, serializeError } from '~/server/log.server'
import { buildEnvelope, parseDsn, parseStack } from '~/server/error-reporting.server'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function captureJsonLog(fn: () => void) {
  vi.stubEnv('LOG_FORMAT', 'json')
  const lines: string[] = []
  const write = (chunk: string | Uint8Array) => {
    lines.push(String(chunk))
    return true
  }
  vi.spyOn(process.stdout, 'write').mockImplementation(write)
  vi.spyOn(process.stderr, 'write').mockImplementation(write)
  fn()
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe('Logger', () => {
  it('schreibt JSON mit Request-ID und Nutzer-ID', () => {
    const [entry] = captureJsonLog(() =>
      requestContext.run({ requestId: 'abc123', userId: 'u1' }, () => logger.info('Anfrage', { status: 200 })),
    )
    expect(entry).toMatchObject({ level: 'info', msg: 'Anfrage', requestId: 'abc123', userId: 'u1', status: 200 })
    expect(typeof entry?.time).toBe('string')
  })

  it('entfernt Passwörter, Tokens und Cookies', () => {
    const [entry] = captureJsonLog(() =>
      logger.info('Test', { password: 'geheim', nested: { accessToken: 'x', cookie: 'y', ok: 1 } }),
    )
    expect(entry?.password).toBe('[entfernt]')
    expect(entry?.nested).toEqual({ accessToken: '[entfernt]', cookie: '[entfernt]', ok: 1 })
  })

  it('beachtet LOG_LEVEL', () => {
    vi.stubEnv('LOG_LEVEL', 'warn')
    const entries = captureJsonLog(() => {
      logger.info('leise')
      logger.error('laut')
    })
    expect(entries.map((e) => e.msg)).toEqual(['laut'])
  })

  it('schreibt Fehler mit Stacktrace, aber ohne Abfrageparameter', () => {
    const error = new Error('Failed query: select * from sessions where id = $1\nparams: geheimer-token-hash')
    const serialized = serializeError(error)
    expect(serialized.message).toBe('Failed query: select * from sessions where id = $1\nparams: [entfernt]')
    expect(String(serialized.stack)).not.toContain('geheimer-token-hash')
    expect(String(serialized.stack)).toContain('logs.test.ts')
  })
})

describe('isUnexpectedError', () => {
  it('erkennt technische Fehler', () => {
    expect(isUnexpectedError(new TypeError('x is undefined'))).toBe(true)
    expect(isUnexpectedError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(true)
    expect(isUnexpectedError(new Error('Failed query: select 1'))).toBe(true)
    expect(isUnexpectedError(new Error('wrapper', { cause: Object.assign(new Error('pg'), { code: '23505' }) }))).toBe(true)
  })

  it('lässt fachliche Meldungen durch', () => {
    expect(isUnexpectedError(new Error('E-Mail-Adresse oder Passwort ist falsch'))).toBe(false)
    expect(isUnexpectedError({ isRedirect: true })).toBe(false)
  })
})

describe('Fehler-Tracking', () => {
  it('liest die DSN von Sentry und GlitchTip', () => {
    expect(parseDsn('https://abc123@o1.ingest.sentry.io/42')).toEqual({
      url: 'https://o1.ingest.sentry.io/api/42/envelope/',
      key: 'abc123',
      dsn: 'https://abc123@o1.ingest.sentry.io/42',
    })
    expect(parseDsn('https://k@glitchtip.example.com/sub/7')?.url).toBe('https://glitchtip.example.com/sub/api/7/envelope/')
    expect(parseDsn('')).toBeNull()
    expect(parseDsn('kein-dsn')).toBeNull()
    expect(parseDsn('https://glitchtip.example.com/7')).toBeNull()
  })

  it('zerlegt den Stacktrace, ältester Aufruf zuerst', () => {
    const frames = parseStack(
      'Error: x\n    at inner (/app/.output/server/chunk.mjs:10:5)\n    at /app/node_modules/pkg/index.js:3:1\n    at node:internal/process:1:1',
    )
    expect(frames.map((f) => [f.function, f.filename, f.lineno, f.in_app])).toEqual([
      [undefined, 'node:internal/process', 1, false],
      [undefined, '/app/node_modules/pkg/index.js', 3, false],
      ['inner', '/app/.output/server/chunk.mjs', 10, true],
    ])
  })

  it('baut einen Envelope mit Request-ID, Nutzer und Ursache, aber ohne Abfrageparameter', () => {
    vi.stubEnv('APP_VERSION', 'v1.2.0')
    const cause = Object.assign(new Error('duplicate key'), { code: '23505' })
    const error = new Error('Failed query: insert into sessions\nparams: geheimer-hash', { cause })
    const [header, item, eventLine] = buildEnvelope(error, { requestId: 'r1', userId: 'u1' }, 'https://k@h/1').split('\n')
    expect(JSON.parse(header!)).toMatchObject({ dsn: 'https://k@h/1' })
    expect(JSON.parse(item!)).toEqual({ type: 'event' })
    const event = JSON.parse(eventLine!)
    expect(event).toMatchObject({ level: 'error', release: 'v1.2.0', tags: { request_id: 'r1' }, user: { id: 'u1' } })
    expect(event.exception.values.map((v: { value: string }) => v.value)).toEqual([
      'duplicate key',
      'Failed query: insert into sessions\nparams: [entfernt]',
    ])
    expect(eventLine).not.toContain('geheimer-hash')
  })

  it('meldet Fehler aus dem Log, sobald SENTRY_DSN gesetzt ist', async () => {
    vi.stubEnv('SENTRY_DSN', 'https://k@sentry.example.com/3')
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () => new Response(null, { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    captureJsonLog(() => {
      logger.error('ohne Fehlerobjekt')
      requestContext.run({ requestId: 'r9' }, () => logger.error('Kaputt', { err: new TypeError('x is undefined') }))
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    const body = typeof init.body === 'string' ? init.body : ''
    expect(url).toBe('https://sentry.example.com/api/3/envelope/')
    expect(body).toContain('"request_id":"r9"')
    expect(body).toContain('x is undefined')
    vi.unstubAllGlobals()
  })
})
