import { z } from 'zod'

export const CONFLICT_MESSAGE =
  'Der Auftrag wurde zwischenzeitlich von jemand anderem geändert. Bitte laden Sie die Ansicht neu und prüfen Sie die Änderungen.'

export function isConflictError(error: unknown): boolean {
  return error instanceof Error && error.message === CONFLICT_MESSAGE
}

const isIssue = (v: unknown): v is { code: string; message: string } =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { code?: unknown }).code === 'string' &&
  typeof (v as { message?: unknown }).message === 'string'

/**
 * Meldungen eines Zod-Validierungsfehlers, oder null. Lehnt der Validator einer Server-Funktion die Eingabe ab,
 * kommt beim Client nur ein Error an, dessen Text die Issues als JSON-Liste enthält (Issue #117).
 */
function validationMessages(error: unknown): string[] | null {
  if (error instanceof z.ZodError) return error.issues.map((i) => i.message)
  if (!(error instanceof Error)) return null
  const text = error.message.trim()
  if (!text.startsWith('[')) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(isIssue)) return parsed.map((i) => i.message)
  } catch {
    // Kein JSON, also eine normale Meldung.
  }
  return null
}

const sentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`)

export function errorMessage(error: unknown): string {
  const issues = validationMessages(error)
  if (issues) return [...new Set(issues.map((m) => sentence(m.trim())))].join(' ')
  if (error instanceof Error && error.message) return error.message
  return 'Es ist ein unerwarteter Fehler aufgetreten.'
}
