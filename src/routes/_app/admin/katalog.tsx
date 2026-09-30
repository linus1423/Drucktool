import { useState, type ReactNode } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { MoneyInput } from '~/components/MoneyInput'
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Select, Textarea, cx } from '~/components/ui'
import { BINDING_UNIT_LABELS, type CatalogTexts, type PaperInput, type Pricing } from '~/lib/catalog'
import { errorMessage } from '~/lib/errors'
import { formatDateTime, formatMoney } from '~/lib/format'
import { adminCatalogQuery, catalogChangesQuery } from '~/lib/queries'
import {
  saveCoverColorFn,
  savePaperFn,
  savePricingFn,
  saveTextsFn,
  setFormatBindingFn,
  updateBindingFn,
  updateFormatFn,
} from '~/server/catalog/catalog.functions'

const TABS = [
  { id: 'formate', label: 'Formate und Bindungen' },
  { id: 'bindungen', label: 'Bindungspreise' },
  { id: 'papiere', label: 'Papiere' },
  { id: 'cover', label: 'Coverfarben' },
  { id: 'preise', label: 'Preise und Texte' },
  { id: 'protokoll', label: 'Änderungen' },
] as const
type Tab = (typeof TABS)[number]['id']

export const Route = createFileRoute('/_app/admin/katalog')({
  validateSearch: z.object({
    tab: z
      .enum(TABS.map((t) => t.id) as [Tab, ...Tab[]])
      .optional()
      .catch(undefined),
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(adminCatalogQuery),
  head: () => ({ meta: [{ title: 'Katalog und Preise · Drucktool' }] }),
  component: CatalogPage,
})

type Catalog = Awaited<ReturnType<NonNullable<typeof adminCatalogQuery.queryFn>>>

function useSave<T>(fn: (input: T) => Promise<unknown>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['catalog'] }),
  })
}

function CatalogPage() {
  const { tab = 'formate' } = Route.useSearch()
  const { data: catalog } = useSuspenseQuery(adminCatalogQuery)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Katalog und Preise"
        description="Änderungen gelten sofort für neue Aufträge. Bereits abgeschickte Aufträge behalten ihre Preise."
      />
      <nav className="flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <Link
            key={t.id}
            to="/admin/katalog"
            search={{ tab: t.id }}
            className={cx(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              t.id === tab ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-900',
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {tab === 'formate' ? <FormatsTab catalog={catalog} /> : null}
      {tab === 'bindungen' ? <BindingsTab catalog={catalog} /> : null}
      {tab === 'papiere' ? <PapersTab catalog={catalog} /> : null}
      {tab === 'cover' ? <CoverTab catalog={catalog} /> : null}
      {tab === 'preise' ? <PricingTab catalog={catalog} /> : null}
      {tab === 'protokoll' ? <ChangesTab catalog={catalog} /> : null}
    </div>
  )
}

function Check({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: ReactNode
  disabled?: boolean
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

function SaveRow({
  mutation,
  onSave,
  dirty,
}: {
  mutation: { isPending: boolean; error: unknown }
  onSave: () => void
  dirty: boolean
}) {
  return (
    <div className="flex items-center justify-end gap-3">
      {mutation.error ? <span className="text-sm text-rose-700">{errorMessage(mutation.error)}</span> : null}
      <Button variant={dirty ? 'primary' : 'secondary'} disabled={!dirty || mutation.isPending} onClick={onSave}>
        {mutation.isPending ? 'Speichern …' : 'Speichern'}
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Formate und Kompatibilität
// ---------------------------------------------------------------------------

function FormatsTab({ catalog }: { catalog: Catalog }) {
  const toggle = useSave(setFormatBindingFn)
  const allowed = new Set(catalog.formatBindings.map((fb) => `${fb.formatId}/${fb.bindingId}`))

  return (
    <div className="space-y-6">
      <Card title="Erlaubte Kombinationen aus Endformat und Bindung">
        {toggle.error ? <Alert>{errorMessage(toggle.error)}</Alert> : null}
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr>
                <th className="px-2 py-2 text-left font-medium text-slate-500">Format</th>
                {catalog.bindings.map((b) => (
                  <th key={b.id} className="px-2 py-2 text-center text-xs font-medium text-slate-500">
                    {b.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {catalog.formats.map((f) => (
                <tr key={f.id}>
                  <td className="px-2 py-2 font-medium whitespace-nowrap">{f.label}</td>
                  {catalog.bindings.map((b) => {
                    const key = `${f.id}/${b.id}`
                    return (
                      <td key={b.id} className="px-2 py-2 text-center">
                        <input
                          type="checkbox"
                          aria-label={`${f.label} mit ${b.label}`}
                          checked={allowed.has(key)}
                          disabled={toggle.isPending}
                          onChange={(e) =>
                            toggle.mutate({ data: { formatId: f.id, bindingId: b.id, allowed: e.target.checked } })
                          }
                        />
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        {catalog.formats.map((f) => (
          <FormatCard key={f.id} format={f} />
        ))}
      </div>
    </div>
  )
}

function FormatCard({ format }: { format: Catalog['formats'][number] }) {
  const [value, setValue] = useState(format)
  const save = useSave(updateFormatFn)
  const dirty = JSON.stringify(value) !== JSON.stringify(format)

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {format.label}
          {format.kind === 'plot' ? <Badge>Plotter</Badge> : null}
          {!format.available ? <Badge className="bg-slate-200 text-slate-600">nicht verfügbar</Badge> : null}
        </span>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Bezeichnung" htmlFor={`f-${format.id}-label`}>
            <Input
              id={`f-${format.id}-label`}
              value={value.label}
              onChange={(e) => setValue({ ...value, label: e.target.value })}
            />
          </Field>
          <Field label="Reihenfolge" htmlFor={`f-${format.id}-sort`}>
            <Input
              id={`f-${format.id}-sort`}
              type="number"
              value={value.sortOrder}
              onChange={(e) => setValue({ ...value, sortOrder: Number(e.target.value) })}
            />
          </Field>
          <div className="space-y-2 pt-6">
            <Check checked={value.available} onChange={(available) => setValue({ ...value, available })} label="Verfügbar" />
            <Check
              checked={value.allowsDuplex}
              onChange={(allowsDuplex) => setValue({ ...value, allowsDuplex })}
              label="Doppelseitig möglich"
            />
          </div>
        </div>
        <Field label="Hilfetext im Wizard" htmlFor={`f-${format.id}-help`}>
          <Textarea
            id={`f-${format.id}-help`}
            rows={2}
            value={value.helpText}
            onChange={(e) => setValue({ ...value, helpText: e.target.value })}
          />
        </Field>
        <SaveRow
          mutation={save}
          dirty={dirty}
          onSave={() => {
            const { kind: _k, widthMm: _w, heightMm: _h, ...data } = value
            save.mutate({ data })
          }}
        />
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Bindungen
// ---------------------------------------------------------------------------

function BindingsTab({ catalog }: { catalog: Catalog }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {catalog.bindings.map((b) => (
        <BindingCard key={b.id} binding={b} />
      ))}
    </div>
  )
}

function BindingCard({ binding }: { binding: Catalog['bindings'][number] }) {
  const [value, setValue] = useState(binding)
  const save = useSave(updateBindingFn)
  const dirty = JSON.stringify(value) !== JSON.stringify(binding)
  const id = `b-${binding.id}`

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {binding.label}
          {!binding.available ? <Badge className="bg-slate-200 text-slate-600">nicht verfügbar</Badge> : null}
        </span>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Bezeichnung" htmlFor={`${id}-label`}>
            <Input id={`${id}-label`} value={value.label} onChange={(e) => setValue({ ...value, label: e.target.value })} />
          </Field>
          <Field label="Reihenfolge" htmlFor={`${id}-sort`}>
            <Input
              id={`${id}-sort`}
              type="number"
              value={value.sortOrder}
              onChange={(e) => setValue({ ...value, sortOrder: Number(e.target.value) })}
            />
          </Field>
          <Field label="Preis" htmlFor={`${id}-price`}>
            <div className="flex gap-2">
              <MoneyInput
                id={`${id}-price`}
                value={value.priceCents}
                onChange={(c) => setValue({ ...value, priceCents: c ?? 0 })}
              />
              <Select
                aria-label="Preiseinheit"
                value={value.priceUnit}
                onChange={(e) => setValue({ ...value, priceUnit: e.target.value as 'copy' | 'sheet' })}
                className="w-40"
              >
                <option value="copy">{BINDING_UNIT_LABELS.copy}</option>
                <option value="sheet">{BINDING_UNIT_LABELS.sheet}</option>
              </Select>
            </div>
          </Field>
          <Field label="Einmalkosten pro Auftrag" htmlFor={`${id}-setup`}>
            <MoneyInput
              id={`${id}-setup`}
              value={value.setupFeeCents}
              onChange={(c) => setValue({ ...value, setupFeeCents: c ?? 0 })}
            />
          </Field>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Check checked={value.available} onChange={(available) => setValue({ ...value, available })} label="Verfügbar" />
          <Check
            checked={value.allowsDuplex}
            onChange={(allowsDuplex) => setValue({ ...value, allowsDuplex })}
            label="Doppelseitig möglich"
          />
          <Check
            checked={value.allowsCover}
            onChange={(allowsCover) => setValue({ ...value, allowsCover })}
            label="Separates Deckblatt, Coverfarbe"
          />
          <Check
            checked={value.allowsSplitCover}
            onChange={(allowsSplitCover) => setValue({ ...value, allowsSplitCover })}
            label="Vorne/hinten unterschiedlich, durchsichtig"
          />
          <Check
            checked={value.trimmed}
            onChange={(trimmed) => setValue({ ...value, trimmed })}
            label="Wird zugeschnitten (randlos möglich)"
          />
        </div>
        <Field label="Hilfetext im Wizard" htmlFor={`${id}-help`}>
          <Textarea
            id={`${id}-help`}
            rows={2}
            value={value.helpText}
            onChange={(e) => setValue({ ...value, helpText: e.target.value })}
          />
        </Field>
        <SaveRow mutation={save} dirty={dirty} onSave={() => save.mutate({ data: value })} />
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Papiere
// ---------------------------------------------------------------------------

const EMPTY_PAPER: PaperInput = {
  name: '',
  grammage: 80,
  priceA3Cents: null,
  priceSra3Cents: null,
  priceA0Cents: null,
  priceA1Cents: null,
  priceA2Cents: null,
  forCover: false,
  forInner: true,
  forPlotter: false,
  maxFormatId: 'A3',
  available: true,
  helpText: '',
  sortOrder: 100,
}

function PapersTab({ catalog }: { catalog: Catalog }) {
  const [adding, setAdding] = useState(false)
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        {!adding ? <Button onClick={() => setAdding(true)}>Papier hinzufügen</Button> : null}
      </div>
      {adding ? <PaperCard paper={EMPTY_PAPER} formats={catalog.formats} onDone={() => setAdding(false)} /> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {catalog.papers.map((p) => {
          const { createdAt: _c, updatedAt: _u, ...paper } = p
          return <PaperCard key={p.id} paper={paper} formats={catalog.formats} />
        })}
      </div>
    </div>
  )
}

function PaperCard({ paper, formats, onDone }: { paper: PaperInput; formats: Catalog['formats']; onDone?: () => void }) {
  const [value, setValue] = useState(paper)
  const save = useSave(savePaperFn)
  const dirty = JSON.stringify(value) !== JSON.stringify(paper)
  const id = `p-${paper.id ?? 'neu'}`
  const money = (key: 'priceA3Cents' | 'priceSra3Cents' | 'priceA0Cents' | 'priceA1Cents' | 'priceA2Cents', label: string) => (
    <Field label={label} htmlFor={`${id}-${key}`}>
      <MoneyInput id={`${id}-${key}`} nullable value={value[key]} onChange={(c) => setValue({ ...value, [key]: c })} />
    </Field>
  )

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {paper.id ? `${paper.name} ${paper.grammage} g/m²` : 'Neues Papier'}
          {!paper.available ? <Badge className="bg-slate-200 text-slate-600">nicht verfügbar</Badge> : null}
        </span>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <Field label="Name" htmlFor={`${id}-name`}>
              <Input id={`${id}-name`} value={value.name} onChange={(e) => setValue({ ...value, name: e.target.value })} />
            </Field>
          </div>
          <Field label="Grammatur (g/m²)" htmlFor={`${id}-g`}>
            <Input
              id={`${id}-g`}
              type="number"
              value={value.grammage}
              onChange={(e) => setValue({ ...value, grammage: Number(e.target.value) })}
            />
          </Field>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Check checked={value.available} onChange={(available) => setValue({ ...value, available })} label="Verfügbar" />
          <Check checked={value.forInner} onChange={(forInner) => setValue({ ...value, forInner })} label="Innenteil geeignet" />
          <Check checked={value.forCover} onChange={(forCover) => setValue({ ...value, forCover })} label="Deckblatt geeignet" />
          <Check checked={value.forPlotter} onChange={(forPlotter) => setValue({ ...value, forPlotter })} label="Plotterpapier" />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {money('priceA3Cents', 'Preis pro A3-Bogen')}
          {money('priceSra3Cents', 'Preis pro SRA3-Bogen')}
          <Field label="Größtes Format" htmlFor={`${id}-max`}>
            <Select
              id={`${id}-max`}
              value={value.maxFormatId ?? ''}
              onChange={(e) => setValue({ ...value, maxFormatId: e.target.value || null })}
            >
              <option value="">Keine Begrenzung</option>
              {formats
                .filter((f) => f.kind !== 'custom')
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        {value.forPlotter ? (
          <div className="grid gap-3 sm:grid-cols-3">
            {money('priceA0Cents', 'Preis pro Plot A0')}
            {money('priceA1Cents', 'Preis pro Plot A1')}
            {money('priceA2Cents', 'Preis pro Plot A2')}
          </div>
        ) : null}
        <Field label="Hilfetext im Wizard" htmlFor={`${id}-help`}>
          <Textarea
            id={`${id}-help`}
            rows={2}
            value={value.helpText}
            onChange={(e) => setValue({ ...value, helpText: e.target.value })}
          />
        </Field>
        <div className="flex justify-end gap-2">
          {onDone ? (
            <Button variant="secondary" onClick={onDone}>
              Abbrechen
            </Button>
          ) : null}
          <SaveRow mutation={save} dirty={dirty} onSave={() => save.mutate({ data: value }, { onSuccess: () => onDone?.() })} />
        </div>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Coverfarben
// ---------------------------------------------------------------------------

function CoverTab({ catalog }: { catalog: Catalog }) {
  const [adding, setAdding] = useState(false)
  return (
    <Card
      title="Coverfarben für Deckblatt und Rückseite"
      actions={!adding ? <Button onClick={() => setAdding(true)}>Farbe hinzufügen</Button> : null}
    >
      <ul className="divide-y divide-slate-100">
        {adding ? (
          <CoverRow
            color={{ name: '', hex: '#ffffff', transparent: false, available: true, sortOrder: 100 }}
            onDone={() => setAdding(false)}
          />
        ) : null}
        {catalog.coverColors.map((c) => (
          <CoverRow key={c.id} color={c} />
        ))}
      </ul>
    </Card>
  )
}

type CoverValue = { id?: string; name: string; hex: string | null; transparent: boolean; available: boolean; sortOrder: number }

function CoverRow({ color, onDone }: { color: CoverValue; onDone?: () => void }) {
  const [value, setValue] = useState(color)
  const save = useSave(saveCoverColorFn)
  const dirty = JSON.stringify(value) !== JSON.stringify(color)
  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <span
        className="h-8 w-8 rounded-full ring-1 ring-slate-300"
        style={{
          background: value.transparent
            ? 'repeating-conic-gradient(#e2e8f0 0 25%, #fff 0 50%) 50% / 12px 12px'
            : (value.hex ?? '#fff'),
        }}
      />
      <Input
        aria-label="Name"
        value={value.name}
        onChange={(e) => setValue({ ...value, name: e.target.value })}
        className="w-48"
      />
      {!value.transparent ? (
        <input
          type="color"
          aria-label="Farbe"
          value={value.hex ?? '#ffffff'}
          onChange={(e) => setValue({ ...value, hex: e.target.value })}
          className="h-9 w-12"
        />
      ) : null}
      <Check
        checked={value.transparent}
        onChange={(transparent) => setValue({ ...value, transparent, hex: transparent ? null : '#ffffff' })}
        label="Durchsichtig"
      />
      <Check checked={value.available} onChange={(available) => setValue({ ...value, available })} label="Verfügbar" />
      <div className="ml-auto flex gap-2">
        {onDone ? (
          <Button variant="secondary" onClick={onDone}>
            Abbrechen
          </Button>
        ) : null}
        <SaveRow mutation={save} dirty={dirty} onSave={() => save.mutate({ data: value }, { onSuccess: () => onDone?.() })} />
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Preise und Texte
// ---------------------------------------------------------------------------

const PRICE_FIELDS: { key: keyof Pricing; label: string; hint?: string }[] = [
  { key: 'printA4Cents', label: 'Farbdruck pro Image A4', hint: 'Eine bedruckte Seite bis A4. Kleinere Formate zählen als A4.' },
  { key: 'printA3Cents', label: 'Farbdruck pro Image A3' },
  { key: 'minimumOrderCents', label: 'Mindestpreis pro Auftrag', hint: 'Ohne Lieferkosten.' },
  { key: 'housePostCents', label: 'Hauspost pro Auftrag' },
  { key: 'housePostPlotCents', label: 'Hauspost bei Plots', hint: 'Laut Lastenheft 2 € extra.' },
]

function PricingTab({ catalog }: { catalog: Catalog }) {
  const [pricing, setPricing] = useState(catalog.pricing)
  const [texts, setTexts] = useState(catalog.texts)
  const savePricing = useSave(savePricingFn)
  const saveTexts = useSave(saveTextsFn)

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Druck, Mindestpreis und Lieferung">
        <div className="space-y-3">
          {PRICE_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} htmlFor={`price-${f.key}`} hint={f.hint}>
              <MoneyInput
                id={`price-${f.key}`}
                value={pricing[f.key]}
                onChange={(c) => setPricing({ ...pricing, [f.key]: c ?? 0 })}
              />
            </Field>
          ))}
          <p className="text-xs text-slate-500">
            Papier- und Plotpreise stehen am Papier, Bindungs- und Laminierpreise an der Bindung.
          </p>
          <SaveRow
            mutation={savePricing}
            dirty={JSON.stringify(pricing) !== JSON.stringify(catalog.pricing)}
            onSave={() => savePricing.mutate({ data: pricing })}
          />
        </div>
      </Card>
      <Card title="Hilfetexte">
        <div className="space-y-3">
          <TextField
            label="Bearbeitungsdauer"
            value={texts.turnaround}
            onChange={(turnaround) => setTexts({ ...texts, turnaround })}
          />
          <TextField label="Was sind Plots?" value={texts.plots} onChange={(plots) => setTexts({ ...texts, plots })} />
          <SaveRow
            mutation={saveTexts}
            dirty={JSON.stringify(texts) !== JSON.stringify(catalog.texts)}
            onSave={() => saveTexts.mutate({ data: texts as CatalogTexts })}
          />
        </div>
      </Card>
    </div>
  )
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const id = `text-${label}`
  return (
    <Field label={label} htmlFor={id}>
      <Textarea id={id} rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  )
}

// ---------------------------------------------------------------------------
// Änderungsprotokoll
// ---------------------------------------------------------------------------

const ENTITY_LABELS: Record<string, string> = {
  format: 'Format',
  binding: 'Bindung',
  format_binding: 'Kombination',
  paper: 'Papier',
  cover_color: 'Coverfarbe',
  settings: 'Einstellung',
}

const FIELD_LABELS: Record<string, string> = {
  label: 'Bezeichnung',
  name: 'Name',
  helpText: 'Hilfetext',
  sortOrder: 'Reihenfolge',
  available: 'Verfügbar',
  allowsDuplex: 'Doppelseitig',
  allowsCover: 'Deckblatt',
  allowsSplitCover: 'Cover vorne/hinten',
  trimmed: 'Zuschnitt',
  priceCents: 'Preis',
  priceUnit: 'Preiseinheit',
  setupFeeCents: 'Einmalkosten',
  grammage: 'Grammatur',
  priceA3Cents: 'Preis A3',
  priceSra3Cents: 'Preis SRA3',
  priceA0Cents: 'Preis A0',
  priceA1Cents: 'Preis A1',
  priceA2Cents: 'Preis A2',
  forCover: 'Deckblatt',
  forInner: 'Innenteil',
  forPlotter: 'Plotter',
  maxFormatId: 'Größtes Format',
  hex: 'Farbe',
  transparent: 'Durchsichtig',
  printA4Cents: 'Druck A4',
  printA3Cents: 'Druck A3',
  minimumOrderCents: 'Mindestpreis',
  housePostCents: 'Hauspost',
  housePostPlotCents: 'Hauspost Plots',
  turnaround: 'Bearbeitungsdauer',
  plots: 'Was sind Plots?',
}

const SETTING_LABELS: Record<string, string> = { pricing: 'Preise', texts: 'Hilfetexte' }

function formatValue(key: string, v: unknown) {
  if (v === null || v === undefined || v === '') return '–'
  if (typeof v === 'number' && /Cents$/.test(key)) return formatMoney(v)
  if (typeof v === 'boolean') return v ? 'ja' : 'nein'
  if (key === 'priceUnit') return BINDING_UNIT_LABELS[v as keyof typeof BINDING_UNIT_LABELS] ?? String(v)
  const text = String(v)
  return text.length > 60 ? `„${text.slice(0, 57)}…“` : typeof v === 'string' ? `„${text}“` : text
}

/** Lesbarer Name des geänderten Eintrags, möglichst aus dem aktuellen Katalog. */
function subject(
  catalog: Catalog,
  c: { entity: string; entityId: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null },
) {
  const formatLabel = (id: string) => catalog.formats.find((f) => f.id === id)?.label ?? id
  const bindingLabel = (id: string) => catalog.bindings.find((b) => b.id === id)?.label ?? id
  switch (c.entity) {
    case 'format':
      return formatLabel(c.entityId)
    case 'binding':
      return bindingLabel(c.entityId)
    case 'format_binding': {
      const [f, b] = c.entityId.split('/')
      return `${formatLabel(f ?? '')} mit ${bindingLabel(b ?? '')}`
    }
    case 'settings':
      return SETTING_LABELS[c.entityId] ?? c.entityId
    default:
      return String((c.after ?? c.before)?.name ?? c.entityId)
  }
}

function describeDiff(entity: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  if (entity === 'format_binding') return after ? 'erlaubt' : 'nicht mehr erlaubt'
  if (!before) return 'angelegt'
  if (!after) return 'entfernt'
  const changed = Object.keys(after).filter((k) => k !== 'updatedAt' && JSON.stringify(before[k]) !== JSON.stringify(after[k]))
  if (changed.length === 0) return 'ohne Änderung gespeichert'
  return changed.map((k) => `${FIELD_LABELS[k] ?? k}: ${formatValue(k, before[k])} → ${formatValue(k, after[k])}`).join(', ')
}

function ChangesTab({ catalog }: { catalog: Catalog }) {
  const changes = useQuery(catalogChangesQuery)
  if (changes.isPending) return <p className="text-sm text-slate-500">Lädt …</p>
  if (changes.error) return <Alert>{errorMessage(changes.error)}</Alert>
  return (
    <Card title="Letzte Änderungen">
      {changes.data.length === 0 ? (
        <p className="text-sm text-slate-500">Noch keine Änderungen.</p>
      ) : (
        <ul className="divide-y divide-slate-100 text-sm">
          {changes.data.map((c) => (
            <li key={c.id} className="py-2">
              <div>
                <span className="font-medium">{c.actorName ?? 'Unbekannt'}</span> · {ENTITY_LABELS[c.entity] ?? c.entity}{' '}
                <span className="font-medium">{subject(catalog, c)}</span>
              </div>
              <div className="break-all text-slate-600">{describeDiff(c.entity, c.before, c.after)}</div>
              <div className="text-xs text-slate-500">{formatDateTime(c.createdAt)}</div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
