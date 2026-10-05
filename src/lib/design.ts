// Erscheinungsbild der Instanz (Issue #186): Name, Logo, Farben und Fußzeile. Reine Funktionen und Schemas, die
// Server, Oberfläche und Mail-Worker gemeinsam nutzen. Ohne Einstellung sieht alles aus wie vor der Design-Seite.
import { z } from 'zod'

export const DEFAULT_SITE_NAME = 'Drucktool'

export const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Bitte eine Farbe im Format #RRGGBB angeben')
  .transform((v) => v.toLowerCase())

/** Nur http(s)- und mailto-Links, damit keine javascript:-Links in der Fußzeile landen. */
export const linkUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^(https?:\/\/|mailto:)\S+$/i.test(v), 'Bitte einen Link mit https://, http:// oder mailto: angeben')

export const LEGAL_PAGE_MODES = ['none', 'url', 'text'] as const

export const legalPageSchema = z
  .object({
    mode: z.enum(LEGAL_PAGE_MODES),
    url: z.string().trim().max(500),
    text: z.string().max(50_000),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'url' && !linkUrlSchema.safeParse(v.url).success) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'Bitte einen Link mit https://, http:// oder mailto: angeben' })
    }
    if (v.mode === 'text' && !v.text.trim())
      ctx.addIssue({ code: 'custom', path: ['text'], message: 'Bitte einen Text eingeben' })
  })
export type LegalPage = z.infer<typeof legalPageSchema>

export const footerLinkSchema = z.object({
  label: z.string().trim().min(1, 'Bezeichnung fehlt').max(60),
  url: linkUrlSchema,
})

export const designColorsSchema = z.object({
  /** Hauptknöpfe, aktive Auswahl, Fokusrahmen. */
  primary: hexColorSchema,
  /** Links, Hinweise, Markierungen für Neues. */
  accent: hexColorSchema,
  /** Hintergrund der Kopfzeile. */
  header: hexColorSchema,
})
export type DesignColors = z.infer<typeof designColorsSchema>

export const designSchema = z.object({
  siteName: z.string().trim().max(60),
  tagline: z.string().trim().max(100),
  /** Mit Logo: Logo und Name nebeneinander oder nur das Logo. */
  logoMode: z.enum(['logo_and_name', 'logo_only']),
  colors: designColorsSchema,
  imprint: legalPageSchema,
  privacy: legalPageSchema,
  footerLinks: z.array(footerLinkSchema).max(10, 'Höchstens 10 Links'),
  footerText: z.string().trim().max(1000),
})
export type Design = z.infer<typeof designSchema>

export const DEFAULT_COLORS: DesignColors = { primary: '#0f172a', accent: '#0ea5e9', header: '#ffffff' }

export const DEFAULT_DESIGN: Design = {
  siteName: '',
  tagline: '',
  logoMode: 'logo_and_name',
  colors: DEFAULT_COLORS,
  imprint: { mode: 'none', url: '', text: '' },
  privacy: { mode: 'none', url: '', text: '' },
  footerLinks: [],
  footerText: '',
}

/** Liest eine gespeicherte Einstellung; fehlende oder ungültige Teile fallen auf den Standard zurück. */
export function parseDesign(value: unknown): Design {
  const stored = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const result = { ...DEFAULT_DESIGN }
  for (const key of Object.keys(DEFAULT_DESIGN) as (keyof Design)[]) {
    const field = designSchema.shape[key].safeParse(stored[key])
    if (field.success) (result as Record<string, unknown>)[key] = field.data
  }
  return result
}

export function siteName(design: Pick<Design, 'siteName'> | null | undefined) {
  return design?.siteName.trim() || DEFAULT_SITE_NAME
}

/** Seitentitel für den Browser-Tab, z. B. „Aufträge · Fachschaftsdruckerei“. */
export function pageTitle(page: string, design: Pick<Design, 'siteName'> | null | undefined) {
  return `${page} · ${siteName(design)}`
}

// ---------------------------------------------------------------------------------------------------------------
// Farben

type Rgb = [number, number, number]

function toRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex([r, g, b]: Rgb) {
  return `#${[r, g, b]
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

/** Mischt a mit b; amount 0 ergibt a, 1 ergibt b. */
export function mix(a: string, b: string, amount: number) {
  const x = toRgb(a)
  const y = toRgb(b)
  return toHex([0, 1, 2].map((i) => x[i]! + (y[i]! - x[i]!) * amount) as Rgb)
}

/** Relative Leuchtdichte nach WCAG 2.1. */
export function luminance(hex: string) {
  const [r, g, b] = toRgb(hex).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as Rgb
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Kontrastverhältnis nach WCAG 2.1 (1 bis 21). */
export function contrast(a: string, b: string) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (l1 + 0.05) / (l2 + 0.05)
}

const WHITE = '#ffffff'
const SLATE = '#0f172a'
const BLACK = '#000000'

/**
 * Textfarbe für einen Hintergrund: Weiß oder das dunkle Schiefergrau der Oberfläche, je nachdem was besser lesbar ist.
 * Reicht keines für 4,5:1, wird es Schwarz; zusammen mit Weiß ist damit jeder Hintergrund mindestens AA.
 */
export function textOn(background: string) {
  const white = contrast(WHITE, background)
  const slate = contrast(SLATE, background)
  if (white >= slate && white >= 4.5) return WHITE
  if (slate >= 4.5) return SLATE
  return white >= contrast(BLACK, background) ? WHITE : BLACK
}

/** Mischt color schrittweise Richtung toward, bis der Kontrast zu background mindestens min beträgt. */
function untilContrast(color: string, toward: string, background: string, min: number) {
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const candidate = mix(color, toward, t)
    if (contrast(candidate, background) >= min) return candidate
  }
  return toward
}

/** Abgeleitete Farben, wie sie als CSS-Variablen in der Oberfläche und in Mails landen. */
export function colorTokens(colors: DesignColors) {
  const primaryFg = textOn(colors.primary)
  const accentSoft = mix(colors.accent, WHITE, 0.88)
  const headerFg = textOn(colors.header)
  return {
    primary: colors.primary,
    primaryFg,
    // Beim Überfahren etwas Richtung Textfarbe aufhellen bzw. abdunkeln.
    primaryHover: mix(colors.primary, primaryFg === WHITE ? WHITE : BLACK, 0.18),
    accent: colors.accent,
    accentSoft,
    accentRing: mix(colors.accent, WHITE, 0.6),
    // Text in Akzentfarbe (Links, Hinweise) muss auf Weiß und auf dem hellen Akzentton lesbar sein.
    accentStrong: untilContrast(colors.accent, BLACK, accentSoft, 4.5),
    header: colors.header,
    headerFg,
  }
}
export type ColorTokens = ReturnType<typeof colorTokens>

/** CSS-Variablen für das style-Attribut des html-Elements; die Standardwerte stehen in styles.css. */
export function colorVariables(colors: DesignColors): Record<string, string> {
  const t = colorTokens(colors)
  return {
    '--color-primary': t.primary,
    '--color-primary-fg': t.primaryFg,
    '--color-primary-hover': t.primaryHover,
    '--color-accent': t.accent,
    '--color-accent-soft': t.accentSoft,
    '--color-accent-ring': t.accentRing,
    '--color-accent-strong': t.accentStrong,
    '--color-header': t.header,
    '--color-header-fg': t.headerFg,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Fußzeile

export type FooterLink = { label: string; href: string }

/** Ziel des Impressums bzw. der Datenschutzerklärung; ohne Einstellung der Link aus der Serverkonfiguration. */
export function legalHref(page: LegalPage, path: string, fallbackUrl: string | null | undefined): string | null {
  if (page.mode === 'url') return page.url
  if (page.mode === 'text') return path
  return fallbackUrl || null
}

// ---------------------------------------------------------------------------------------------------------------
// Logo

export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] as const
export type LogoType = (typeof LOGO_TYPES)[number]
export const LOGO_MAX_BYTES = 512 * 1024
export const LOGO_KINDS = ['logo', 'favicon'] as const
export type LogoKind = (typeof LOGO_KINDS)[number]

/** Erkennt das Bildformat am Inhalt, nicht an der Endung. Gibt null zurück, wenn es kein erlaubtes Format ist. */
export function detectImageType(bytes: Uint8Array): LogoType | null {
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b)
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 2048)).replace(/^﻿/, '').trimStart()
  // SVG: optional XML-Deklaration, Kommentare und Doctype, dann das svg-Element.
  const rest = head.replace(/^(<\?xml[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[\s\S]*?>\s*)*/i, '')
  if (/^<svg[\s>]/i.test(rest)) return 'image/svg+xml'
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// Einfache Textseiten (Impressum, Datenschutz)

export type TextNode = { kind: 'h2' | 'h3' | 'p'; parts: TextPart[] } | { kind: 'ul'; items: TextPart[][] }
export type TextPart = { text: string; href?: string }

const LINK = /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)|((?:https?:\/\/)[^\s<>()]+[^\s<>().,;:!?])/gi

/** Text mit [Bezeichnung](https://…) und nackten https-Links in Teile zerlegen. */
function inline(text: string): TextPart[] {
  const parts: TextPart[] = []
  let last = 0
  for (const m of text.matchAll(LINK)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) })
    if (m[3]) parts.push({ text: m[3], href: m[3] })
    else parts.push({ text: m[1]!, href: m[2]! })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  return parts
}

/**
 * Sehr kleines Markdown für Impressum und Datenschutz: „# “ und „## “ als Überschriften, „- “ als Liste, Leerzeilen
 * trennen Absätze, Links als [Text](https://…). Ergebnis sind Knoten statt HTML, damit nichts eingeschleust werden kann.
 */
export function parseSimpleText(source: string): TextNode[] {
  const nodes: TextNode[] = []
  for (const block of source.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((l) => l.trim())
    if (!lines.length) continue
    let paragraph: string[] = []
    let list: TextPart[][] = []
    const flush = () => {
      if (paragraph.length) nodes.push({ kind: 'p', parts: inline(paragraph.join('\n')) })
      if (list.length) nodes.push({ kind: 'ul', items: list })
      paragraph = []
      list = []
    }
    for (const line of lines) {
      const heading = /^(#{1,3})\s+(.*)$/.exec(line.trim())
      const item = /^[-*]\s+(.*)$/.exec(line.trim())
      if (heading) {
        flush()
        nodes.push({ kind: heading[1]!.length === 1 ? 'h2' : 'h3', parts: inline(heading[2]!) })
      } else if (item) {
        if (paragraph.length) flush()
        list.push(inline(item[1]!))
      } else {
        if (list.length) flush()
        paragraph.push(line)
      }
    }
    flush()
  }
  return nodes
}
