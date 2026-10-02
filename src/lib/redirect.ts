/** Übernimmt nur relative Pfade als Weiterleitungsziel, damit kein Open Redirect entsteht. */
export function safeRedirect(target: string | null | undefined) {
  return target && target.startsWith('/') && !target.startsWith('//') && !target.startsWith('/\\') ? target : '/uebersicht'
}

/**
 * Erste Anmeldung ohne Rechnungsadresse: erst ins Profil, danach weiter zum ursprünglichen Ziel, z. B. einer
 * Einladung in eine Organisation (Issue #137).
 */
export function firstLoginProfileUrl(target: string | null | undefined) {
  const next = safeRedirect(target)
  return next === '/uebersicht' ? '/profil?neu=1' : `/profil?neu=1&weiter=${encodeURIComponent(next)}`
}
