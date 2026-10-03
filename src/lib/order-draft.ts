import { z } from 'zod'
import { COVER_FROM_MAIN_FILE, DELIVERY_METHODS } from './order'

/**
 * Zwischenspeicher des Bestell-Assistenten im Browser (Issue #175). Gespeichert wird je Benutzer und Art
 * (eigene Bestellung oder Angebot für einen Kunden), damit sich die beiden nicht gegenseitig überschreiben.
 * Dateien stehen nur als IDs drin; ob sie noch existieren und dem Benutzer gehören, prüft der Server beim Laden.
 */
export const DRAFT_VERSION = 1

export type DraftKind = 'order' | 'offer'

export function draftStorageKey(userId: string, kind: DraftKind) {
  return `drucktool:auftrag-entwurf:v${DRAFT_VERSION}:${userId}:${kind}`
}

const text = (max = 5000) => z.string().max(max)

export const storedDraftSchema = z.object({
  version: z.literal(DRAFT_VERSION),
  step: z.number().int().min(0).max(20),
  organisationId: text(100),
  mainFileId: z.uuid().nullable(),
  coverFileId: z.uuid().nullable(),
  manualPages: text(20),
  formatId: text(100),
  customWidth: text(20),
  customHeight: text(20),
  bindingId: text(100),
  duplex: z.boolean(),
  paperId: text(100),
  coverEnabled: z.boolean(),
  coverPaperId: text(100),
  coverFromMain: z.enum(COVER_FROM_MAIN_FILE),
  coverColorId: text(100),
  coverBackColorId: text(100),
  borderless: z.boolean(),
  copies: text(20),
  title: text(500),
  notes: text(),
  delivery: z.enum(DELIVERY_METHODS),
  deliveryAddress: z.object({
    recipient: text(500),
    department: text(500),
    building: text(500),
    room: text(500),
    note: text(),
  }),
  offer: z.boolean(),
  customerEmail: text(500),
  customerFirstName: text(500),
  customerLastName: text(500),
  priceOverride: z.number().int().min(0).nullable(),
  priceReason: text(),
})
export type StoredDraft = z.infer<typeof storedDraftSchema>

/** Liest einen gespeicherten Entwurf; Kaputtes oder eine alte Version zählt als kein Entwurf. */
export function parseStoredDraft(raw: string | null): StoredDraft | null {
  if (!raw) return null
  try {
    const result = storedDraftSchema.safeParse(JSON.parse(raw))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

/** localStorage, falls es ihn gibt und er benutzbar ist (nicht auf dem Server, nicht bei gesperrtem Speicher). */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function loadDraft(key: string): StoredDraft | null {
  try {
    return parseStoredDraft(storage()?.getItem(key) ?? null)
  } catch {
    return null
  }
}

export function saveDraft(key: string, draft: StoredDraft) {
  try {
    storage()?.setItem(key, JSON.stringify(draft))
  } catch {
    // Speicher voll oder gesperrt: dann eben ohne Zwischenspeicher.
  }
}

export function clearDraft(key: string) {
  try {
    storage()?.removeItem(key)
  } catch {
    // wie oben
  }
}
