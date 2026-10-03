// Findet zu einer Organisationsanfrage die ähnlichsten bestehenden Organisationen (Issue #176).
// Bewertet wird vor allem der Name; gleiche Stammdaten (USt-IdNr., Kostenstelle, Adresse, E-Mail-Domain) heben die Bewertung.

export type OrganisationFields = {
  name: string
  email?: string | null
  street?: string | null
  zip?: string | null
  city?: string | null
  vatId?: string | null
  costCenter?: string | null
}

/** Ab dieser Bewertung gilt eine Organisation als Vorschlag. */
export const SUGGESTION_THRESHOLD = 0.4
/** Ab dieser Bewertung ist die Zuordnung so naheliegend, dass sie vorausgewählt wird. */
export const STRONG_MATCH_THRESHOLD = 0.75

// Füllwörter und Rechtsformen sagen nichts darüber aus, welche Organisation gemeint ist.
const STOP_WORDS = new Set([
  'der',
  'die',
  'das',
  'des',
  'den',
  'dem',
  'und',
  'fuer',
  'von',
  'im',
  'in',
  'am',
  'an',
  'zu',
  'zur',
  'zum',
  'the',
  'of',
  'and',
  'for',
  'ev',
  'gmbh',
  'ag',
  'kg',
  'ug',
  'gbr',
])

// Bei Freemailern sagt die gleiche Domain nichts über die Organisation.
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'web.de',
  'gmx.de',
  'gmx.net',
  'gmx.at',
  'outlook.com',
  'outlook.de',
  'hotmail.com',
  'hotmail.de',
  'live.de',
  'yahoo.com',
  'yahoo.de',
  'icloud.com',
  'me.com',
  't-online.de',
  'freenet.de',
  'posteo.de',
  'mailbox.org',
  'protonmail.com',
  'proton.me',
])

function fold(value: string) {
  return value
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
}

export function nameTokens(name: string) {
  return (
    fold(name)
      // „e. V.“ als ein Wort, damit es als Rechtsform wegfällt.
      .replace(/\be\.\s*v\./g, 'ev')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((t) => t && !STOP_WORDS.has(t))
  )
}

function bigrams(value: string) {
  const grams = new Map<string, number>()
  for (let i = 0; i < value.length - 1; i++) {
    const gram = value.slice(i, i + 2)
    grams.set(gram, (grams.get(gram) ?? 0) + 1)
  }
  return grams
}

/** Sørensen-Dice-Koeffizient über Buchstabenpaare, robust gegen Tippfehler und Umstellungen. */
function dice(a: string, b: string) {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const left = bigrams(a)
  const right = bigrams(b)
  let overlap = 0
  for (const [gram, n] of left) overlap += Math.min(n, right.get(gram) ?? 0)
  return (2 * overlap) / (a.length - 1 + b.length - 1)
}

/**
 * Ob abbr eine Abkürzung der Wörter ist: Jedes Wort steuert der Reihe nach mindestens seinen Anfangsbuchstaben bei,
 * weitere Buchstaben dürfen aus dem Wortinneren stammen (Komposita: „Fach-Schaft Maschinen-Bau“ ergibt „FSMB“).
 */
function isAcronym(abbr: string, tokens: string[]): boolean {
  if (abbr.length < 2 || tokens.length < 2 || abbr.length > 10) return false
  const match = (a: number, t: number): boolean => {
    if (t === tokens.length) return a === abbr.length
    const token = tokens[t]!
    if (abbr[a] !== token[0]) return false
    // Danach beliebig viele weitere Buchstaben aus demselben Wort, in Reihenfolge.
    let pos = 1
    for (let next = a + 1; ; next++) {
      if (match(next, t + 1)) return true
      if (next >= abbr.length) return false
      const found = token.indexOf(abbr[next]!, pos)
      if (found < 0) return false
      pos = found + 1
    }
  }
  return match(0, 0)
}

/** Ähnlichkeit zweier Namen zwischen 0 und 1. */
export function nameSimilarity(a: string, b: string) {
  const left = nameTokens(a)
  const right = nameTokens(b)
  if (left.length === 0 || right.length === 0) return 0
  const joinedLeft = left.join(' ')
  const joinedRight = right.join(' ')
  if (joinedLeft === joinedRight) return 1
  // Abkürzung gegen ausgeschriebenen Namen, etwa „FSMB“ und „Fachschaft Maschinenbau“.
  if ((left.length === 1 && isAcronym(left[0]!, right)) || (right.length === 1 && isAcronym(right[0]!, left))) return 0.85
  // Anteil der Wörter, die im anderen Namen (fast) gleich vorkommen.
  const covered = (from: string[], to: string[]) => from.filter((t) => to.some((u) => dice(t, u) >= 0.8)).length
  const tokenScore = (covered(left, right) + covered(right, left)) / (left.length + right.length)
  // Ein Name steckt vollständig im anderen, etwa „Fachschaft Maschinenbau“ in „Fachschaft Maschinenbau TUM“.
  // Je mehr vom längeren Namen übrig bleibt, desto unsicherer ist die Zuordnung.
  const shorter = Math.min(left.length, right.length)
  const longer = Math.max(left.length, right.length)
  const contained =
    covered(left, right) === left.length || covered(right, left) === right.length ? 0.5 + (0.4 * shorter) / longer : 0
  return Math.max(dice(joinedLeft, joinedRight), tokenScore, contained)
}

const same = (a?: string | null, b?: string | null) => {
  const left = fold(a ?? '').replace(/[^a-z0-9]/g, '')
  const right = fold(b ?? '').replace(/[^a-z0-9]/g, '')
  return left !== '' && left === right
}

function mailDomain(email?: string | null) {
  const domain = email?.trim().toLowerCase().split('@')[1] ?? ''
  return domain && !FREE_MAIL_DOMAINS.has(domain) ? domain : ''
}

/** Bewertet, wie gut eine bestehende Organisation zur Anfrage passt (0 bis 1). */
export function organisationMatchScore(request: OrganisationFields, organisation: OrganisationFields) {
  // Gleiche USt-IdNr. heißt gleiche Organisation.
  if (same(request.vatId, organisation.vatId)) return 1
  let score = nameSimilarity(request.name, organisation.name)
  if (same(request.costCenter, organisation.costCenter)) score += 0.3
  if (same(request.zip, organisation.zip) && same(request.street, organisation.street)) score += 0.2
  else if (same(request.zip, organisation.zip) || same(request.city, organisation.city)) score += 0.05
  const domain = mailDomain(request.email)
  if (domain && domain === mailDomain(organisation.email)) score += 0.15
  return Math.min(1, score)
}

/** Die passendsten Organisationen, beste zuerst; nur solche über der Vorschlagsschwelle. */
export function suggestOrganisations<T extends OrganisationFields & { id: string }>(
  request: OrganisationFields,
  organisations: T[],
  limit = 3,
) {
  return organisations
    .map((o) => ({ id: o.id, name: o.name, score: organisationMatchScore(request, o) }))
    .filter((o) => o.score >= SUGGESTION_THRESHOLD)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'de'))
    .slice(0, limit)
}
