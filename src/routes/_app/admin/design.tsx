import { useState, type CSSProperties } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Alert, Button, Card, Field, Input, PageHeader, Select, Textarea, cx } from '~/components/ui'
import { errorMessage } from '~/lib/errors'
import {
  DEFAULT_COLORS,
  DEFAULT_SITE_NAME,
  LOGO_MAX_BYTES,
  LOGO_TYPES,
  colorVariables,
  designSchema,
  hexColorSchema,
  pageTitle,
  type Design,
  type DesignColors,
  type LegalPage,
  type LogoKind,
} from '~/lib/design'
import { designQuery, designSettingsQuery } from '~/lib/queries'
import { removeLogoFn, saveDesignFn, saveLogoFn } from '~/server/design/design.functions'

export const Route = createFileRoute('/_app/admin/design')({
  loader: ({ context }) => context.queryClient.ensureQueryData(designSettingsQuery),
  head: ({ match }) => ({ meta: [{ title: pageTitle('Design', match.context.design) }] }),
  component: DesignPage,
})

/** Nach dem Speichern Kopfzeile, Farben, Fußzeile und Seitentitel überall neu laden. */
function useRefresh() {
  const queryClient = useQueryClient()
  const router = useRouter()
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: designSettingsQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: designQuery.queryKey }),
    ])
    await router.invalidate()
  }
}

function DesignPage() {
  const { data } = useSuspenseQuery(designSettingsQuery)
  const [draft, setDraft] = useState<Design>(data.design)
  const refresh = useRefresh()
  const save = useMutation({
    mutationFn: (design: Design) => saveDesignFn({ data: design }),
    onSuccess: (_, design) => {
      setDraft(design)
      return refresh()
    },
  })
  const parsed = designSchema.safeParse(draft)
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.design)
  const issue = (...path: (string | number)[]) =>
    parsed.success
      ? undefined
      : parsed.error.issues.find((i) => path.every((p, n) => i.path[n] === p) && i.path.length === path.length)?.message

  return (
    <div className="space-y-6">
      <PageHeader
        title="Design"
        description="Name, Logo, Farben und Fußzeile des Drucktools. Änderungen gelten sofort für alle Seiten und neu verschickte E-Mails."
      />
      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault()
          if (parsed.success) save.mutate(parsed.data)
        }}
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Name in der Kopfzeile">
            <div className="space-y-4">
              <Field
                label="Name"
                htmlFor="design-name"
                error={issue('siteName')}
                hint={`Steht in der Kopfzeile, auf der Anmeldeseite und im Browser-Tab. Leer: „${DEFAULT_SITE_NAME}“.`}
              >
                <Input
                  id="design-name"
                  value={draft.siteName}
                  maxLength={60}
                  placeholder={DEFAULT_SITE_NAME}
                  onChange={(e) => setDraft({ ...draft, siteName: e.target.value })}
                />
              </Field>
              <Field
                label="Untertitel"
                htmlFor="design-tagline"
                error={issue('tagline')}
                hint="Optional, z. B. „Fachschaftsdruckerei“."
              >
                <Input
                  id="design-tagline"
                  value={draft.tagline}
                  maxLength={100}
                  onChange={(e) => setDraft({ ...draft, tagline: e.target.value })}
                />
              </Field>
              <fieldset>
                <legend className="mb-1 block text-sm font-medium text-slate-700">Mit Logo anzeigen</legend>
                <div className="space-y-1 text-sm">
                  {(
                    [
                      ['logo_and_name', 'Logo und Name'],
                      ['logo_only', 'Nur das Logo'],
                    ] as const
                  ).map(([value, label]) => (
                    <label key={value} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="logo-mode"
                        value={value}
                        checked={draft.logoMode === value}
                        onChange={() => setDraft({ ...draft, logoMode: value })}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
          </Card>
          <Card title="Logo und Favicon">
            <div className="space-y-6">
              <LogoUpload
                kind="logo"
                label="Logo"
                url={data.logoUrl}
                hint="Erscheint in der Kopfzeile, auf der Anmeldeseite und oben in E-Mails. Am besten ein querformatiges Bild mit transparentem Hintergrund."
              />
              <LogoUpload
                kind="favicon"
                label="Favicon"
                url={data.faviconUrl}
                hint="Kleines quadratisches Symbol im Browser-Tab. Ohne Upload gilt das Standardsymbol."
              />
            </div>
          </Card>
        </div>

        <ColorsCard colors={draft.colors} onChange={(colors) => setDraft({ ...draft, colors })} />

        <Card title="Fußzeile">
          <div className="grid gap-6 lg:grid-cols-2">
            <LegalPageEditor
              id="imprint"
              label="Impressum"
              path="/impressum"
              fallbackUrl={data.fallback.imprintUrl}
              value={draft.imprint}
              onChange={(imprint) => setDraft({ ...draft, imprint })}
              urlError={issue('imprint', 'url')}
              textError={issue('imprint', 'text')}
            />
            <LegalPageEditor
              id="privacy"
              label="Datenschutzerklärung"
              path="/datenschutz"
              fallbackUrl={data.fallback.privacyUrl}
              value={draft.privacy}
              onChange={(privacy) => setDraft({ ...draft, privacy })}
              urlError={issue('privacy', 'url')}
              textError={issue('privacy', 'text')}
            />
            <FooterLinksEditor
              links={draft.footerLinks}
              onChange={(footerLinks) => setDraft({ ...draft, footerLinks })}
              issue={(index, field) => issue('footerLinks', index, field)}
            />
            <Field
              label="Freier Text"
              htmlFor="design-footer-text"
              error={issue('footerText')}
              hint="Z. B. Anschrift, Öffnungszeiten oder Kontaktadresse. Zeilenumbrüche bleiben erhalten."
            >
              <Textarea
                id="design-footer-text"
                rows={4}
                maxLength={1000}
                value={draft.footerText}
                onChange={(e) => setDraft({ ...draft, footerText: e.target.value })}
              />
            </Field>
          </div>
        </Card>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!parsed.success || !dirty || save.isPending}>
            Speichern
          </Button>
          {dirty ? (
            <Button variant="secondary" onClick={() => setDraft(data.design)}>
              Änderungen verwerfen
            </Button>
          ) : null}
          {!parsed.success && dirty ? <span className="text-sm text-rose-600">Bitte die markierten Felder prüfen.</span> : null}
          {save.isSuccess && !dirty ? (
            <span role="status" className="text-sm text-emerald-700">
              Gespeichert.
            </span>
          ) : null}
          {save.isError ? <span className="text-sm text-rose-600">{errorMessage(save.error)}</span> : null}
        </div>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------

function readAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result.replace(/^data:[^,]*,/, '') : '')
    reader.onerror = () => reject(new Error('Die Datei konnte nicht gelesen werden.'))
    reader.readAsDataURL(file)
  })
}

function LogoUpload({ kind, label, url, hint }: { kind: LogoKind; label: string; url: string | null; hint: string }) {
  const refresh = useRefresh()
  const [inputKey, setInputKey] = useState(0)
  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > LOGO_MAX_BYTES) throw new Error(`Die Datei ist zu groß (höchstens ${LOGO_MAX_BYTES / 1024} KB).`)
      return saveLogoFn({ data: { kind, data: await readAsBase64(file) } })
    },
    onSettled: () => setInputKey((k) => k + 1),
    onSuccess: refresh,
  })
  const remove = useMutation({ mutationFn: () => removeLogoFn({ data: { kind } }), onSuccess: refresh })
  const id = `design-${kind}`

  return (
    <div className="space-y-2">
      <Field label={label} htmlFor={id} hint={hint}>
        <input
          key={inputKey}
          id={id}
          type="file"
          accept={LOGO_TYPES.join(',')}
          className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-900 hover:file:bg-slate-200"
          disabled={upload.isPending}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) upload.mutate(file)
          }}
        />
      </Field>
      <p className="text-xs text-slate-600">PNG, JPEG, WebP oder SVG, höchstens {LOGO_MAX_BYTES / 1024} KB.</p>
      {url ? (
        <div className="flex flex-wrap items-center gap-3">
          <div className="rounded-md bg-slate-50 p-2 ring-1 ring-slate-200">
            <img
              src={url}
              alt={`Aktuelles ${label}`}
              className={kind === 'favicon' ? 'h-8 w-8 object-contain' : 'max-h-16 max-w-48'}
            />
          </div>
          <Button variant="secondary" onClick={() => remove.mutate()} disabled={remove.isPending}>
            {label} entfernen
          </Button>
        </div>
      ) : null}
      {upload.isError ? <Alert>{errorMessage(upload.error)}</Alert> : null}
      {remove.isError ? <Alert>{errorMessage(remove.error)}</Alert> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Farben
// ---------------------------------------------------------------------------

const COLOR_FIELDS: { key: keyof DesignColors; label: string; hint: string }[] = [
  { key: 'primary', label: 'Primärfarbe', hint: 'Hauptknöpfe, ausgewählte Optionen, Fokusrahmen.' },
  { key: 'accent', label: 'Akzentfarbe', hint: 'Links, Hinweise, Markierungen für Neues.' },
  { key: 'header', label: 'Kopfzeile', hint: 'Hintergrund der Kopfzeile.' },
]

function ColorsCard({ colors, onChange }: { colors: DesignColors; onChange: (c: DesignColors) => void }) {
  // Ungültige Eingaben bleiben im Entwurf stehen; die Vorschau nutzt dann für dieses Feld den Standard.
  const isValid = (v: string) => hexColorSchema.safeParse(v).success
  const preview = Object.fromEntries(
    COLOR_FIELDS.map((f) => [f.key, isValid(colors[f.key]) ? colors[f.key].toLowerCase() : DEFAULT_COLORS[f.key]]),
  ) as DesignColors
  const set = (key: keyof DesignColors, value: string) => onChange({ ...colors, [key]: value })
  const isDefault = JSON.stringify(colors) === JSON.stringify(DEFAULT_COLORS)

  return (
    <Card
      title="Farben"
      actions={
        isDefault ? null : (
          <Button variant="ghost" onClick={() => onChange(DEFAULT_COLORS)}>
            Auf Standard zurücksetzen
          </Button>
        )
      }
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          {COLOR_FIELDS.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              htmlFor={`color-${f.key}`}
              hint={f.hint}
              error={isValid(colors[f.key]) ? undefined : 'Bitte eine Farbe im Format #RRGGBB angeben'}
            >
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label={`${f.label} auswählen`}
                  className="h-9 w-12 cursor-pointer rounded-md border-0 bg-white p-0.5 ring-1 ring-slate-300"
                  value={preview[f.key]}
                  onChange={(e) => set(f.key, e.target.value)}
                />
                <Input
                  id={`color-${f.key}`}
                  className="w-32 font-mono"
                  value={colors[f.key]}
                  maxLength={7}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              </div>
            </Field>
          ))}
          <p className="text-xs text-slate-600">
            Die Schriftfarbe auf Knöpfen und in der Kopfzeile wählt das Drucktool selbst (hell oder dunkel), damit der Kontrast
            immer ausreicht.
          </p>
        </div>
        <ColorPreview colors={preview} />
      </div>
    </Card>
  )
}

/** Vorschau mit den gewählten Farben; die CSS-Variablen gelten nur innerhalb dieses Kastens. */
function ColorPreview({ colors }: { colors: DesignColors }) {
  return (
    <div
      aria-label="Vorschau"
      role="group"
      className="overflow-hidden rounded-lg bg-slate-50 ring-1 ring-slate-200"
      style={colorVariables(colors) as CSSProperties}
    >
      <div className="flex items-center gap-2 border-b border-slate-200 bg-header px-3 py-2 text-header-fg">
        <span className="font-semibold">Kopfzeile</span>
        <span className="rounded-md bg-header-fg/10 px-2 py-1 text-sm font-medium">Aktiv</span>
        <span className="px-2 py-1 text-sm font-medium text-header-fg/80">Link</span>
      </div>
      <div className="space-y-3 p-3">
        <div className="flex flex-wrap gap-2">
          <Button tabIndex={-1}>Hauptknopf</Button>
          <Button tabIndex={-1} variant="secondary">
            Zweiter Knopf
          </Button>
        </div>
        <Alert tone="info">Ein Hinweis in der Akzentfarbe.</Alert>
        <p className="text-sm">
          Text mit <span className="font-medium text-accent-strong underline">Link</span> und{' '}
          <span className="rounded bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent-strong">Neu</span>
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Fußzeile
// ---------------------------------------------------------------------------

function LegalPageEditor({
  id,
  label,
  path,
  fallbackUrl,
  value,
  onChange,
  urlError,
  textError,
}: {
  id: string
  label: string
  path: string
  fallbackUrl: string | null
  value: LegalPage
  onChange: (v: LegalPage) => void
  urlError?: string
  textError?: string
}) {
  return (
    <div className="space-y-3">
      <Field
        label={label}
        htmlFor={`${id}-mode`}
        hint={
          value.mode === 'none'
            ? fallbackUrl
              ? `Aus der Serverkonfiguration: ${fallbackUrl}`
              : 'Kein Link in der Fußzeile.'
            : value.mode === 'text'
              ? `Wird unter ${path} angezeigt, auch ohne Anmeldung.`
              : undefined
        }
      >
        <Select
          id={`${id}-mode`}
          value={value.mode}
          onChange={(e) => onChange({ ...value, mode: e.target.value as LegalPage['mode'] })}
        >
          <option value="none">{fallbackUrl ? 'Aus der Serverkonfiguration' : 'Nicht anzeigen'}</option>
          <option value="url">Link auf eine andere Seite</option>
          <option value="text">Eigener Text im Drucktool</option>
        </Select>
      </Field>
      {value.mode === 'url' ? (
        <Field label={`Link zum ${label === 'Impressum' ? 'Impressum' : 'Datenschutz'}`} htmlFor={`${id}-url`} error={urlError}>
          <Input
            id={`${id}-url`}
            type="url"
            placeholder="https://"
            value={value.url}
            onChange={(e) => onChange({ ...value, url: e.target.value })}
          />
        </Field>
      ) : null}
      {value.mode === 'text' ? (
        <Field
          label={`Text ${label === 'Impressum' ? 'des Impressums' : 'der Datenschutzerklärung'}`}
          htmlFor={`${id}-text`}
          error={textError}
          hint="Überschriften mit „# “ oder „## “, Listen mit „- “, Links als [Text](https://…). Leerzeile = neuer Absatz."
        >
          <Textarea
            id={`${id}-text`}
            rows={10}
            value={value.text}
            onChange={(e) => onChange({ ...value, text: e.target.value })}
          />
        </Field>
      ) : null}
    </div>
  )
}

function FooterLinksEditor({
  links,
  onChange,
  issue,
}: {
  links: Design['footerLinks']
  onChange: (links: Design['footerLinks']) => void
  issue: (index: number, field: 'label' | 'url') => string | undefined
}) {
  const set = (index: number, patch: Partial<Design['footerLinks'][number]>) =>
    onChange(links.map((l, i) => (i === index ? { ...l, ...patch } : l)))
  const move = (index: number, delta: number) => {
    const next = [...links]
    const [link] = next.splice(index, 1)
    next.splice(index + delta, 0, link!)
    onChange(next)
  }
  return (
    <fieldset className="space-y-3 lg:col-span-2">
      <legend className="block text-sm font-medium text-slate-700">Weitere Links</legend>
      <p className="text-sm text-slate-600">Z. B. Kontakt, Öffnungszeiten oder Auftragsbedingungen. Höchstens 10.</p>
      {links.length ? (
        <ol className="space-y-3">
          {links.map((link, index) => (
            <li key={index} className="grid gap-2 rounded-md p-3 ring-1 ring-slate-200 sm:grid-cols-[1fr_2fr_auto]">
              <Field label="Bezeichnung" htmlFor={`footer-link-${index}-label`} error={issue(index, 'label')}>
                <Input
                  id={`footer-link-${index}-label`}
                  value={link.label}
                  maxLength={60}
                  onChange={(e) => set(index, { label: e.target.value })}
                />
              </Field>
              <Field label="Adresse" htmlFor={`footer-link-${index}-url`} error={issue(index, 'url')}>
                <Input
                  id={`footer-link-${index}-url`}
                  placeholder="https:// oder mailto:"
                  value={link.url}
                  onChange={(e) => set(index, { url: e.target.value })}
                />
              </Field>
              <div className="flex items-end gap-1">
                <Button
                  variant="ghost"
                  aria-label={`${link.label || 'Link'} nach oben`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </Button>
                <Button
                  variant="ghost"
                  aria-label={`${link.label || 'Link'} nach unten`}
                  disabled={index === links.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </Button>
                <Button variant="ghost" onClick={() => onChange(links.filter((_, i) => i !== index))}>
                  Entfernen
                </Button>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      <Button
        variant="secondary"
        className={cx(links.length >= 10 && 'hidden')}
        onClick={() => onChange([...links, { label: '', url: '' }])}
      >
        Link hinzufügen
      </Button>
    </fieldset>
  )
}
