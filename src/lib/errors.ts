export const CONFLICT_MESSAGE =
  'Die Anfrage wurde zwischenzeitlich von jemand anderem geändert. Bitte laden Sie die Ansicht neu und prüfen Sie die Änderungen.'

export function isConflictError(error: unknown): boolean {
  return error instanceof Error && error.message === CONFLICT_MESSAGE
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'Es ist ein unerwarteter Fehler aufgetreten.'
}
