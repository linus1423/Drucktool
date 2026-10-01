/** Übernimmt nur relative Pfade als Weiterleitungsziel, damit kein Open Redirect entsteht. */
export function safeRedirect(target: string | null | undefined) {
  return target && target.startsWith('/') && !target.startsWith('//') && !target.startsWith('/\\') ? target : '/uebersicht'
}
