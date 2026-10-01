export type PersonName = { firstName: string; lastName: string }

/**
 * Anzeigename „Vorname Nachname“. Entspricht der generierten Spalte users.name
 * (btrim(first_name || ' ' || last_name)), damit Listen, Mails und Suche einheitlich bleiben.
 */
export function displayName(n: PersonName): string {
  return `${n.firstName.trim()} ${n.lastName.trim()}`.trim()
}

/**
 * Zerlegt einen zusammengesetzten Namen am letzten Leerzeichen: „Anna Maria Muster“ wird zu
 * Vorname „Anna Maria“ und Nachname „Muster“. Ohne Leerzeichen landet alles im Nachnamen.
 * Dieselbe Regel nutzt die Migration 0015 für bestehende Daten.
 */
export function splitName(full: string): PersonName {
  const name = full.trim().replace(/\s+/g, ' ')
  const i = name.lastIndexOf(' ')
  if (i < 0) return { firstName: '', lastName: name }
  return { firstName: name.slice(0, i), lastName: name.slice(i + 1) }
}
