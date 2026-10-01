import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { z } from 'zod'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { FileUpload, type UploadedFile } from '~/components/FileUpload'
import { HelpTip } from '~/components/HelpTip'
import { Alert, Button, Card, Field, Input, PageHeader, Select, Textarea, cx } from '~/components/ui'
import { EMPTY_DELIVERY, deliveryAddressSchema, type DeliveryAddress } from '~/lib/address'
import { errorMessage } from '~/lib/errors'
import { formatMoney, formatRequestNumber } from '~/lib/format'
import {
  CUSTOM_MAX_MM,
  CUSTOM_MIN_MM,
  DELIVERY_LABELS,
  MAX_COVER_PAGES,
  bindingChoices,
  borderlessChoice,
  coverColorChoices,
  duplexChoice,
  findFormat,
  formatSize,
  paperChoices,
  suggestFormat,
  type DeliveryMethod,
  type OrderCatalog,
  type OrderSpec,
} from '~/lib/order'
import { calculatePrice } from '~/lib/pricing'
import { accountQuery, activeOrganisationsQuery, orderCatalogQuery } from '~/lib/queries'
import { isStaffRole } from '~/lib/roles'
import { createRequestFn, prepareReorderFn } from '~/server/requests/requests.functions'

export const Route = createFileRoute('/_app/auftraege/neu')({
  // ?vorlage=<id>: Nachbestellung eines früheren Auftrags (Issue #10)
  validateSearch: z.object({ vorlage: z.uuid().optional().catch(undefined) }),
  loader: ({ context }) =>
    Promise.all([context.queryClient.ensureQueryData(orderCatalogQuery), context.queryClient.ensureQueryData(accountQuery)]),
  head: () => ({ meta: [{ title: 'Neuer Auftrag · Drucktool' }] }),
  component: NewOrderPage,
})

const STEPS = ['Datei', 'Format', 'Bindung', 'Papier', 'Optionen', 'Lieferung', 'Absenden'] as const

type Draft = {
  mainFile: UploadedFile | null
  manualPages: string
  formatId: string
  customWidth: string
  customHeight: string
  bindingId: string
  duplex: boolean
  paperId: string
  coverEnabled: boolean
  coverPaperId: string
  coverFile: UploadedFile | null
  coverManualPages: number
  coverColorId: string
  coverBackColorId: string
  borderless: boolean
  copies: string
  title: string
  notes: string
  delivery: DeliveryMethod
  deliveryAddress: DeliveryAddress
  acceptTerms: boolean
}

const int = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : null)

function pagesOf(d: Draft) {
  return d.mainFile?.pageCount ?? int(d.manualPages)
}

function coverPagesOf(d: Draft) {
  if (!d.coverEnabled || !d.coverFile) return null
  return d.coverFile.pageCount ?? d.coverManualPages
}

/** Baut aus dem Entwurf eine Bestellung, sobald alle Pflichtangaben da sind. */
function toSpec(d: Draft): OrderSpec | null {
  const pages = pagesOf(d)
  const copies = int(d.copies)
  if (!d.formatId || !d.bindingId || !d.paperId || !pages || !copies) return null
  return {
    formatId: d.formatId,
    customWidthMm: int(d.customWidth),
    customHeightMm: int(d.customHeight),
    bindingId: d.bindingId,
    duplex: d.duplex,
    paperId: d.paperId,
    coverPaperId: d.coverEnabled && d.coverPaperId ? d.coverPaperId : null,
    coverPages: coverPagesOf(d),
    coverColorId: d.coverColorId || null,
    coverBackColorId: d.coverBackColorId || null,
    borderless: d.borderless,
    copies,
    pages,
    delivery: d.delivery,
  }
}

/** Entfernt Auswahlen, die nach einer Änderung nicht mehr erlaubt sind. */
function normalize(catalog: OrderCatalog, d: Draft): Draft {
  const next = { ...d }
  const format = findFormat(catalog, next.formatId)
  const size = format
    ? formatSize(format, { customWidthMm: int(next.customWidth), customHeightMm: int(next.customHeight) })
    : null
  if (!bindingChoices(catalog, format).some((c) => c.item.id === next.bindingId && c.allowed)) next.bindingId = ''
  const binding = catalog.bindings.find((b) => b.id === next.bindingId)
  if (next.duplex && !duplexChoice(format, binding).allowed) next.duplex = false
  if (!paperChoices(catalog, format, size, 'inner').some((c) => c.item.id === next.paperId && c.allowed)) next.paperId = ''
  if (!binding?.allowsCover) {
    next.coverEnabled = false
    next.coverColorId = ''
    next.coverBackColorId = ''
  }
  const colors = coverColorChoices(catalog, binding)
  if (!colors.some((c) => c.item.id === next.coverColorId && c.allowed)) next.coverColorId = ''
  if (!binding?.allowsSplitCover || !colors.some((c) => c.item.id === next.coverBackColorId && c.allowed))
    next.coverBackColorId = ''
  if (!paperChoices(catalog, format, size, 'cover').some((c) => c.item.id === next.coverPaperId && c.allowed))
    next.coverPaperId = ''
  const paper = catalog.papers.find((p) => p.id === next.paperId)
  if (next.borderless && !borderlessChoice(format, binding, paper, size).allowed) next.borderless = false
  return next
}

function NewOrderPage() {
  const { user } = Route.useRouteContext()
  const staff = isStaffRole(user.role)
  const { data: catalog } = useSuspenseQuery(orderCatalogQuery)
  const { data: account } = useSuspenseQuery(accountQuery)
  const activeOrganisations = useQuery({ ...activeOrganisationsQuery, enabled: staff })
  // Mitarbeiter wählen jede aktive Organisation, Kunden eine ihrer eigenen (Issue #68). Mit genau
  // einer Organisation ist sie vorausgewählt; "Keine" bleibt immer möglich.
  const organisations = staff ? (activeOrganisations.data ?? []) : user.organisations
  const [organisationId, setOrganisationId] = useState(() =>
    !staff && user.organisations.length === 1 ? user.organisations[0]!.id : '',
  )
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [step, setStep] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const { vorlage } = Route.useSearch()
  // POST mit Seiteneffekt (Dateikopien), deshalb nur einmal je Vorlage und ohne Wiederholung.
  const template = useQuery({
    queryKey: ['reorder', vorlage],
    queryFn: () => prepareReorderFn({ data: { id: vorlage! } }),
    enabled: !!vorlage,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const applied = useRef<string | null>(null)
  const [draft, setDraft] = useState<Draft>(() => ({
    mainFile: null,
    manualPages: '',
    formatId: '',
    customWidth: '',
    customHeight: '',
    bindingId: '',
    duplex: false,
    paperId: '',
    coverEnabled: false,
    coverPaperId: '',
    coverFile: null,
    coverManualPages: 1,
    coverColorId: '',
    coverBackColorId: '',
    borderless: false,
    copies: '1',
    title: '',
    notes: '',
    delivery: 'pickup',
    deliveryAddress: account.deliveryAddress ?? { ...EMPTY_DELIVERY, recipient: account.name },
    acceptTerms: false,
  }))

  const update = (patch: Partial<Draft>) => setDraft((d) => normalize(catalog, { ...d, ...patch }))

  useEffect(() => {
    const t = template.data
    if (!t || applied.current === t.source.id) return
    applied.current = t.source.id
    const s = t.spec
    setDraft((d) =>
      normalize(catalog, {
        ...d,
        mainFile: t.mainFile,
        manualPages: String(s.pages),
        formatId: s.formatId,
        customWidth: s.customWidthMm?.toString() ?? '',
        customHeight: s.customHeightMm?.toString() ?? '',
        bindingId: s.bindingId,
        duplex: s.duplex,
        paperId: s.paperId,
        coverEnabled: !!s.coverPaperId && !!t.coverFile,
        coverPaperId: s.coverPaperId ?? '',
        coverFile: t.coverFile,
        coverManualPages: s.coverPages ?? 1,
        coverColorId: s.coverColorId ?? '',
        coverBackColorId: s.coverBackColorId ?? '',
        borderless: s.borderless,
        copies: String(s.copies),
        title: t.title,
        notes: t.notes,
        delivery: s.delivery,
        deliveryAddress: t.deliveryAddress ?? d.deliveryAddress,
      }),
    )
    // Bei einer Nachbestellung ändert sich meist nur die Anzahl.
    setStep(4)
  }, [template.data, catalog])
  // Katalog kann sich nach "Preis geändert" neu laden; Auswahlen dann erneut prüfen.
  useEffect(() => setDraft((d) => normalize(catalog, d)), [catalog])

  const format = findFormat(catalog, draft.formatId)
  const size = format
    ? formatSize(format, { customWidthMm: int(draft.customWidth), customHeightMm: int(draft.customHeight) })
    : null
  const binding = catalog.bindings.find((b) => b.id === draft.bindingId)
  const paper = catalog.papers.find((p) => p.id === draft.paperId)
  const spec = toSpec(draft)
  const priced = useMemo(() => (spec ? calculatePrice(catalog, spec) : null), [catalog, spec && JSON.stringify(spec)])

  const blockers = stepBlockers(catalog, draft)
  const firstBlocked = blockers.findIndex((b) => b !== null)
  const canOpen = (i: number) => firstBlocked === -1 || i <= firstBlocked

  const submit = async () => {
    if (!spec || !priced?.ok || !draft.mainFile) return
    setError(null)
    setSubmitting(true)
    try {
      const created = await createRequestFn({
        data: {
          title: draft.title,
          notes: draft.notes,
          spec,
          mainFileId: draft.mainFile.id,
          coverFileId: draft.coverEnabled && draft.coverFile ? draft.coverFile.id : null,
          deliveryAddress: draft.delivery === 'house_post' ? draft.deliveryAddress : null,
          acceptTerms: true,
          expectedTotalCents: priced.price.totalCents,
          organisationId: organisationId || undefined,
          reorderOfId: template.data?.source.id,
        },
      })
      await queryClient.invalidateQueries({ queryKey: ['requests'] })
      await navigate({ to: '/auftraege/$requestId', params: { requestId: created.id } })
    } catch (e) {
      setError(errorMessage(e))
      // Bei geänderten Preisen den aktuellen Katalog laden, damit die Vorschau stimmt.
      await queryClient.invalidateQueries({ queryKey: orderCatalogQuery.queryKey })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="Neuer Auftrag"
        description="Schritt für Schritt zum Druckauftrag. Verbindlich wird er erst, wenn die Druckerei ihn bestätigt."
      />
      {!staff && !account.billingAddress ? (
        <div className="mb-4">
          <Alert>
            Bitte hinterlegen Sie zuerst eine Rechnungsadresse in Ihrem{' '}
            <Link to="/profil" className="underline">
              Profil
            </Link>
            .
          </Alert>
        </div>
      ) : null}

      {vorlage ? (
        <div className="mb-4">
          {template.isPending ? (
            <Alert tone="info">Die Vorlage wird geladen …</Alert>
          ) : template.error ? (
            <Alert>{errorMessage(template.error)}</Alert>
          ) : template.data ? (
            <Alert tone="info">
              Nachbestellung von{' '}
              <Link to="/auftraege/$requestId" params={{ requestId: template.data.source.id }} className="underline">
                {formatRequestNumber(template.data.source.number)}
              </Link>
              . Optionen und Dateien sind übernommen; der Preis wird mit den aktuellen Preisen neu berechnet. Bitte alles prüfen.
            </Alert>
          ) : null}
        </div>
      ) : null}

      <nav aria-label="Schritte" className="mb-4 overflow-x-auto">
        <ol className="flex min-w-max gap-1 text-sm">
          {STEPS.map((label, i) => (
            <li key={label}>
              <button
                type="button"
                disabled={!canOpen(i)}
                onClick={() => setStep(i)}
                aria-current={i === step ? 'step' : undefined}
                className={cx(
                  'rounded-full px-3 py-1',
                  i === step
                    ? 'bg-slate-900 text-white'
                    : canOpen(i)
                      ? 'bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-100'
                      : 'text-slate-400',
                )}
              >
                {i + 1}. {label}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title={`${step + 1}. ${STEP_TITLES[step]}`}>
            <div className="space-y-4">
              {step === 0 ? <FileStep draft={draft} update={update} catalog={catalog} /> : null}
              {step === 1 ? <FormatStep draft={draft} update={update} catalog={catalog} /> : null}
              {step === 2 ? <BindingStep draft={draft} update={update} catalog={catalog} /> : null}
              {step === 3 ? <PaperStep draft={draft} update={update} catalog={catalog} /> : null}
              {step === 4 ? <OptionsStep draft={draft} update={update} catalog={catalog} /> : null}
              {step === 5 ? <DeliveryStep draft={draft} update={update} catalog={catalog} /> : null}
              {step === 6 ? (
                <SubmitStep
                  draft={draft}
                  update={update}
                  catalog={catalog}
                  organisationField={
                    staff || organisations.length > 0 ? (
                      <Field label="Organisation (optional)" htmlFor="organisationId">
                        <Select id="organisationId" value={organisationId} onChange={(e) => setOrganisationId(e.target.value)}>
                          <option value="">Keine</option>
                          {organisations.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    ) : null
                  }
                />
              ) : null}
              {blockers[step] ? <p className="text-sm text-slate-500">{blockers[step]}</p> : null}
              {error ? <Alert>{error}</Alert> : null}
              <div className="flex justify-between gap-2 border-t border-slate-100 pt-4">
                <Button variant="secondary" disabled={step === 0} onClick={() => setStep(step - 1)}>
                  Zurück
                </Button>
                {step < STEPS.length - 1 ? (
                  <Button disabled={!!blockers[step]} onClick={() => setStep(step + 1)}>
                    Weiter
                  </Button>
                ) : (
                  <Button disabled={firstBlocked !== -1 || !priced?.ok || submitting} onClick={() => void submit()}>
                    {submitting ? 'Wird gesendet …' : 'Auftrag verbindlich absenden'}
                  </Button>
                )}
              </div>
            </div>
          </Card>
        </div>
        <aside className="lg:sticky lg:top-4 lg:self-start">
          <PricePreview
            catalog={catalog}
            draft={draft}
            priced={priced}
            formatLabel={format?.label}
            bindingLabel={binding?.label}
            paperLabel={paper?.name}
            size={size}
          />
        </aside>
      </div>
    </div>
  )
}

const STEP_TITLES = [
  'Druckdatei hochladen',
  'Endformat wählen',
  'Bindung und Seiten',
  'Papier und Deckblatt',
  'Weitere Optionen',
  'Lieferung',
  'Prüfen und absenden',
] as const

/** Warum ein Schritt noch nicht fertig ist, oder null. */
function stepBlockers(catalog: OrderCatalog, d: Draft): (string | null)[] {
  const format = findFormat(catalog, d.formatId)
  const size = format ? formatSize(format, { customWidthMm: int(d.customWidth), customHeightMm: int(d.customHeight) }) : null
  const file = !d.mainFile ? 'Bitte die Druckdatei hochladen.' : !pagesOf(d) ? 'Bitte die Seitenzahl angeben.' : null
  let fmt: string | null = null
  if (!format) fmt = 'Bitte ein Endformat wählen.'
  else if (!size) fmt = 'Bitte Breite und Höhe angeben.'
  else if (format.kind === 'custom') {
    const w = int(d.customWidth)!
    const h = int(d.customHeight)!
    const [s, l] = [Math.min(w, h), Math.max(w, h)]
    if (s < CUSTOM_MIN_MM || s > CUSTOM_MAX_MM.short || l > CUSTOM_MAX_MM.long) {
      fmt = `Das Sonderformat muss zwischen ${CUSTOM_MIN_MM} mm und ${CUSTOM_MAX_MM.short} × ${CUSTOM_MAX_MM.long} mm liegen.`
    }
  }
  const bind = !d.bindingId ? 'Bitte eine Bindung wählen.' : null
  let paper: string | null = !d.paperId ? 'Bitte ein Papier wählen.' : null
  if (!paper && d.coverEnabled) {
    if (!d.coverPaperId) paper = 'Bitte ein Papier für das Deckblatt wählen.'
    else if (!d.coverFile) paper = 'Bitte die Datei für das Deckblatt hochladen.'
    else if ((d.coverFile.pageCount ?? 0) > MAX_COVER_PAGES)
      paper = `Die Deckblatt-Datei darf höchstens ${MAX_COVER_PAGES} Seiten haben.`
  }
  const copies = int(d.copies)
  const options = !d.title.trim()
    ? 'Bitte einen Titel angeben.'
    : !copies || copies < 1
      ? 'Bitte die Anzahl der Exemplare angeben.'
      : null
  const delivery =
    d.delivery === 'house_post' && !deliveryAddressSchema.safeParse(d.deliveryAddress).success
      ? 'Bitte mindestens den Empfänger für die Hauspost angeben.'
      : null
  const terms = !d.acceptTerms ? 'Bitte den Auftragsbedingungen zustimmen.' : null
  return [file, fmt, bind, paper, options, delivery, terms]
}

type StepProps = { draft: Draft; update: (patch: Partial<Draft>) => void; catalog: OrderCatalog }

function ChoiceCard({
  selected,
  disabled,
  onSelect,
  title,
  help,
  children,
  reason,
}: {
  selected: boolean
  disabled?: boolean
  onSelect: () => void
  title: ReactNode
  help?: string
  children?: ReactNode
  reason?: string
}) {
  return (
    <div
      className={cx(
        'rounded-lg p-3 text-left text-sm ring-1 transition',
        selected
          ? 'bg-slate-900 text-white ring-slate-900'
          : disabled
            ? 'bg-slate-50 text-slate-400 ring-slate-200'
            : 'bg-white ring-slate-300 hover:ring-slate-500',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          disabled={disabled}
          onClick={onSelect}
          className="flex-1 text-left font-medium disabled:cursor-not-allowed"
        >
          {title}
        </button>
        {help ? <HelpTip label={typeof title === 'string' ? title : 'Option'}>{help}</HelpTip> : null}
      </div>
      {children ? <div className={cx('mt-1 text-xs', selected ? 'text-slate-200' : 'text-slate-500')}>{children}</div> : null}
      {disabled && reason ? <div className="mt-1 text-xs">{reason}</div> : null}
    </div>
  )
}

function FileStep({ draft, update, catalog }: StepProps) {
  const file = draft.mainFile
  const suggestion =
    file?.pageWidthMm && file.pageHeightMm
      ? suggestFormat(catalog.formats, { widthMm: file.pageWidthMm, heightMm: file.pageHeightMm })
      : undefined
  return (
    <>
      <p className="text-sm text-slate-600">
        Laden Sie Ihre Druckdatei als PDF hoch. Wir lesen die Seitenzahl und das Format aus und schlagen passende Optionen vor.
      </p>
      <FileUpload
        role="main"
        label="Druckdatei"
        value={file}
        onChange={(f) => {
          const suggested =
            f?.pageWidthMm && f.pageHeightMm
              ? suggestFormat(catalog.formats, { widthMm: f.pageWidthMm, heightMm: f.pageHeightMm })
              : undefined
          update({
            mainFile: f,
            manualPages: '',
            ...(suggested && !draft.formatId ? { formatId: suggested.id } : {}),
            ...(f && !draft.title ? { title: f.filename.replace(/\.pdf$/i, '') } : {}),
          })
        }}
      />
      {file && file.pdfStatus !== 'ok' ? (
        <Alert tone="info">
          {file.pdfStatus === 'encrypted'
            ? 'Die PDF ist geschützt. Wir nehmen sie trotzdem an und prüfen sie vor dem Druck.'
            : file.pdfStatus === 'not_pdf'
              ? 'Die Datei ist keine PDF. Wir nehmen sie trotzdem an und melden uns, falls wir sie nicht drucken können.'
              : 'Wir konnten die Datei nicht auswerten. Wir nehmen sie trotzdem an und prüfen sie vor dem Druck.'}
        </Alert>
      ) : null}
      {file && file.pageCount == null ? (
        <Field label="Seitenzahl" htmlFor="manualPages" hint="Bitte geben Sie an, wie viele Seiten die Datei hat.">
          <Input
            id="manualPages"
            inputMode="numeric"
            className="w-32"
            value={draft.manualPages}
            onChange={(e) => update({ manualPages: e.target.value })}
          />
        </Field>
      ) : null}
      {file?.mixedPageSizes ? (
        <Alert tone="info">
          Die Seiten Ihrer Datei sind unterschiedlich groß. Wir drucken alle Seiten im gewählten Endformat.
        </Alert>
      ) : null}
      {suggestion ? (
        <p className="text-sm text-slate-600">
          Die Seiten haben das Format {suggestion.label}
          {draft.formatId === suggestion.id ? ', das ist als Endformat vorausgewählt.' : '.'}
        </p>
      ) : null}
    </>
  )
}

function FormatStep({ draft, update, catalog }: StepProps) {
  const file = draft.mainFile
  const format = findFormat(catalog, draft.formatId)
  const size = format
    ? formatSize(format, { customWidthMm: int(draft.customWidth), customHeightMm: int(draft.customHeight) })
    : null
  const mismatch =
    file?.pageWidthMm && file.pageHeightMm && size
      ? Math.abs(Math.min(file.pageWidthMm, file.pageHeightMm) - Math.min(size.widthMm, size.heightMm)) > 3 ||
        Math.abs(Math.max(file.pageWidthMm, file.pageHeightMm) - Math.max(size.widthMm, size.heightMm)) > 3
      : false
  const plots = catalog.formats.filter((f) => f.kind === 'plot')
  const others = catalog.formats.filter((f) => f.kind !== 'plot')
  const grid = (list: typeof catalog.formats) => (
    <div role="radiogroup" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {list.map((f) => (
        <ChoiceCard
          key={f.id}
          selected={draft.formatId === f.id}
          onSelect={() => update({ formatId: f.id })}
          title={f.label}
          help={f.helpText || undefined}
        >
          {f.widthMm && f.heightMm ? `${f.widthMm} × ${f.heightMm} mm` : 'Maße frei wählbar'}
        </ChoiceCard>
      ))}
    </div>
  )
  return (
    <>
      {grid(others)}
      {plots.length ? (
        <div className="space-y-2">
          <h3 className="flex items-center text-sm font-medium text-slate-700">
            Großformat (Plots)
            {catalog.texts.plots ? <HelpTip label="Plots">{catalog.texts.plots}</HelpTip> : null}
          </h3>
          {grid(plots)}
        </div>
      ) : null}
      {format?.kind === 'custom' ? (
        <div className="flex flex-wrap gap-4">
          <Field label="Breite (mm)" htmlFor="customWidth">
            <Input
              id="customWidth"
              inputMode="numeric"
              className="w-32"
              value={draft.customWidth}
              onChange={(e) => update({ customWidth: e.target.value })}
            />
          </Field>
          <Field label="Höhe (mm)" htmlFor="customHeight">
            <Input
              id="customHeight"
              inputMode="numeric"
              className="w-32"
              value={draft.customHeight}
              onChange={(e) => update({ customHeight: e.target.value })}
            />
          </Field>
        </div>
      ) : null}
      {mismatch ? (
        <Alert tone="info">
          Ihre Datei hat {file!.pageWidthMm} × {file!.pageHeightMm} mm, das Endformat ist {size!.widthMm} × {size!.heightMm} mm.
          Wir passen die Seiten an das Endformat an.
        </Alert>
      ) : null}
    </>
  )
}

function BindingStep({ draft, update, catalog }: StepProps) {
  const format = findFormat(catalog, draft.formatId)
  const binding = catalog.bindings.find((b) => b.id === draft.bindingId)
  const duplex = duplexChoice(format, binding)
  return (
    <>
      <div role="radiogroup" aria-label="Bindung" className="grid gap-2 sm:grid-cols-2">
        {bindingChoices(catalog, format).map(({ item, allowed, reason }) => (
          <ChoiceCard
            key={item.id}
            selected={draft.bindingId === item.id}
            disabled={!allowed}
            reason={reason}
            onSelect={() => update({ bindingId: item.id })}
            title={item.label}
            help={item.helpText || undefined}
          />
        ))}
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-slate-700">Seiten</h3>
        <div role="radiogroup" aria-label="Seiten" className="grid grid-cols-2 gap-2">
          <ChoiceCard selected={!draft.duplex} onSelect={() => update({ duplex: false })} title="Einseitig" />
          <ChoiceCard
            selected={draft.duplex}
            disabled={!duplex.allowed}
            reason={duplex.reason}
            onSelect={() => update({ duplex: true })}
            title="Doppelseitig"
          />
        </div>
      </div>
    </>
  )
}

function PaperStep({ draft, update, catalog }: StepProps) {
  const format = findFormat(catalog, draft.formatId)
  const size = format
    ? formatSize(format, { customWidthMm: int(draft.customWidth), customHeightMm: int(draft.customHeight) })
    : null
  const binding = catalog.bindings.find((b) => b.id === draft.bindingId)
  const colors = coverColorChoices(catalog, binding)
  const paperList = (purpose: 'inner' | 'cover', value: string, onSelect: (id: string) => void) => (
    <div role="radiogroup" className="grid gap-2 sm:grid-cols-2">
      {paperChoices(catalog, format, size, purpose)
        .filter((c) => c.allowed || purpose === 'inner')
        .map(({ item, allowed, reason }) => (
          <ChoiceCard
            key={item.id}
            selected={value === item.id}
            disabled={!allowed}
            reason={reason}
            onSelect={() => onSelect(item.id)}
            title={`${item.name} ${item.grammage} g/m²`}
            help={item.helpText || undefined}
          />
        ))}
    </div>
  )
  return (
    <>
      {paperList('inner', draft.paperId, (paperId) => update({ paperId }))}
      {binding?.allowsCover ? (
        <div className="space-y-3 border-t border-slate-100 pt-4">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input type="checkbox" checked={draft.coverEnabled} onChange={(e) => update({ coverEnabled: e.target.checked })} />
            Separates Deckblatt aus anderem Papier
            <HelpTip label="Deckblatt">
              Das Deckblatt laden Sie als eigene PDF hoch: eine Seite für vorne und optional eine zweite für hinten. Es wird
              einseitig auf das gewählte Papier gedruckt.
            </HelpTip>
          </label>
          {draft.coverEnabled ? (
            <>
              {paperList('cover', draft.coverPaperId, (coverPaperId) => update({ coverPaperId }))}
              <FileUpload
                role="cover"
                label="Deckblatt"
                value={draft.coverFile}
                onChange={(coverFile) => update({ coverFile })}
              />
              {draft.coverFile && draft.coverFile.pageCount == null ? (
                <Field label="Seiten im Deckblatt" htmlFor="coverPages">
                  <Select
                    id="coverPages"
                    className="w-48"
                    value={draft.coverManualPages}
                    onChange={(e) => update({ coverManualPages: Number(e.target.value) })}
                  >
                    <option value={1}>1 (nur vorne)</option>
                    <option value={2}>2 (vorne und hinten)</option>
                  </Select>
                </Field>
              ) : null}
            </>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={binding.allowsSplitCover ? 'Coverfarbe vorne' : 'Coverfarbe'} htmlFor="coverColor">
              <Select id="coverColor" value={draft.coverColorId} onChange={(e) => update({ coverColorId: e.target.value })}>
                <option value="">Standard</option>
                {colors
                  .filter((c) => c.allowed)
                  .map(({ item }) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </Select>
            </Field>
            {binding.allowsSplitCover ? (
              <Field label="Coverfarbe hinten" htmlFor="coverBackColor">
                <Select
                  id="coverBackColor"
                  value={draft.coverBackColorId}
                  onChange={(e) => update({ coverBackColorId: e.target.value })}
                >
                  <option value="">Wie vorne</option>
                  {colors
                    .filter((c) => c.allowed)
                    .map(({ item }) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                </Select>
              </Field>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  )
}

function OptionsStep({ draft, update, catalog }: StepProps) {
  const format = findFormat(catalog, draft.formatId)
  const size = format
    ? formatSize(format, { customWidthMm: int(draft.customWidth), customHeightMm: int(draft.customHeight) })
    : null
  const binding = catalog.bindings.find((b) => b.id === draft.bindingId)
  const paper = catalog.papers.find((p) => p.id === draft.paperId)
  const borderless = borderlessChoice(format, binding, paper, size)
  return (
    <>
      <Field label="Titel" htmlFor="title" hint="Damit Sie und wir den Auftrag wiederfinden, z. B. „Skript Thermodynamik“.">
        <Input id="title" value={draft.title} onChange={(e) => update({ title: e.target.value })} />
      </Field>
      <Field label="Anzahl Exemplare" htmlFor="copies">
        <Input
          id="copies"
          inputMode="numeric"
          className="w-32"
          value={draft.copies}
          onChange={(e) => update({ copies: e.target.value })}
        />
      </Field>
      <div className="space-y-1">
        <label
          className={cx('flex items-center gap-2 text-sm font-medium', borderless.allowed ? 'text-slate-700' : 'text-slate-400')}
        >
          <input
            type="checkbox"
            disabled={!borderless.allowed}
            checked={draft.borderless}
            onChange={(e) => update({ borderless: e.target.checked })}
          />
          Randlos drucken
          <HelpTip label="Randlos">
            Unser Drucker kann nicht bis zum Rand drucken. Für randlose Ergebnisse drucken wir auf einen größeren Bogen und
            schneiden zu.
          </HelpTip>
        </label>
        {!borderless.allowed ? <p className="text-xs text-slate-500">{borderless.reason}</p> : null}
        {borderless.allowed && (draft.borderless || binding?.trimmed) && borderless.note ? (
          <p className="text-xs text-slate-500">{borderless.note}</p>
        ) : null}
      </div>
      <Field label="Bemerkungen (optional)" htmlFor="notes" hint="Alles, was wir sonst noch wissen sollten.">
        <Textarea id="notes" rows={4} value={draft.notes} onChange={(e) => update({ notes: e.target.value })} />
      </Field>
    </>
  )
}

function DeliveryStep({ draft, update }: StepProps) {
  const a = draft.deliveryAddress
  const set = (patch: Partial<DeliveryAddress>) => update({ deliveryAddress: { ...a, ...patch } })
  return (
    <>
      <div role="radiogroup" aria-label="Lieferung" className="grid gap-2 sm:grid-cols-2">
        {(['pickup', 'house_post'] as const).map((m) => (
          <ChoiceCard key={m} selected={draft.delivery === m} onSelect={() => update({ delivery: m })} title={DELIVERY_LABELS[m]}>
            {m === 'pickup'
              ? 'Sie holen den fertigen Auftrag im Regal der Druckerei ab.'
              : 'Wir schicken den Auftrag per Hauspost an Ihren Lehrstuhl.'}
          </ChoiceCard>
        ))}
      </div>
      {draft.delivery === 'house_post' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Empfänger" htmlFor="recipient">
            <Input id="recipient" value={a.recipient} onChange={(e) => set({ recipient: e.target.value })} />
          </Field>
          <Field label="Lehrstuhl / Einrichtung" htmlFor="department">
            <Input id="department" value={a.department} onChange={(e) => set({ department: e.target.value })} />
          </Field>
          <Field label="Gebäude" htmlFor="building">
            <Input id="building" value={a.building} onChange={(e) => set({ building: e.target.value })} />
          </Field>
          <Field label="Raum" htmlFor="room">
            <Input id="room" value={a.room} onChange={(e) => set({ room: e.target.value })} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Hinweis für die Hauspost" htmlFor="deliveryNote">
              <Input id="deliveryNote" value={a.note} onChange={(e) => set({ note: e.target.value })} />
            </Field>
          </div>
        </div>
      ) : null}
    </>
  )
}

function SubmitStep({ draft, update, catalog, organisationField }: StepProps & { organisationField: ReactNode }) {
  return (
    <>
      {organisationField}
      <Alert tone="info">
        Mit dem Absenden geben Sie ein verbindliches Angebot zum angezeigten Preis ab. Der Auftrag kommt erst zustande, wenn ein
        Mitarbeiter der Druckerei ihn bestätigt.
      </Alert>
      {catalog.texts.terms ? (
        <details className="rounded-md bg-slate-50 p-3 text-sm text-slate-700">
          <summary className="cursor-pointer font-medium">Auftragsbedingungen lesen</summary>
          <p className="mt-2 whitespace-pre-line">{catalog.texts.terms}</p>
        </details>
      ) : null}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={draft.acceptTerms}
          onChange={(e) => update({ acceptTerms: e.target.checked })}
        />
        <span>Ich habe die Auftragsbedingungen gelesen und stimme ihnen zu.</span>
      </label>
      {catalog.texts.turnaround ? <p className="text-sm text-slate-500">{catalog.texts.turnaround}</p> : null}
    </>
  )
}

function PricePreview({
  catalog,
  draft,
  priced,
  formatLabel,
  bindingLabel,
  paperLabel,
  size,
}: {
  catalog: OrderCatalog
  draft: Draft
  priced: ReturnType<typeof calculatePrice> | null
  formatLabel?: string
  bindingLabel?: string
  paperLabel?: string
  size: { widthMm: number; heightMm: number } | null
}) {
  const pages = pagesOf(draft)
  const rows: [string, string | undefined][] = [
    ['Datei', draft.mainFile ? `${draft.mainFile.filename}${pages ? `, ${pages} S.` : ''}` : undefined],
    [
      'Format',
      formatLabel &&
        (findFormat(catalog, draft.formatId)?.kind === 'custom' && size ? `${size.widthMm} × ${size.heightMm} mm` : formatLabel),
    ],
    ['Bindung', bindingLabel && `${bindingLabel}, ${draft.duplex ? 'doppelseitig' : 'einseitig'}`],
    ['Papier', paperLabel],
    ['Exemplare', draft.copies],
    ['Lieferung', DELIVERY_LABELS[draft.delivery]],
  ]
  return (
    <Card title="Preisvorschau">
      <dl className="space-y-1 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-2">
            <dt className="text-slate-500">{label}</dt>
            <dd className="truncate text-right text-slate-900">{value || '–'}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 border-t border-slate-100 pt-3 text-sm">
        {priced?.ok ? (
          <dl className="space-y-1">
            <div className="flex justify-between">
              <dt>Druckkosten</dt>
              <dd>{formatMoney(priced.price.printCents)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Lieferkosten</dt>
              <dd>{formatMoney(priced.price.deliveryCents)}</dd>
            </div>
            <div className="flex justify-between text-base font-semibold" data-testid="price-total">
              <dt>Gesamt</dt>
              <dd>{formatMoney(priced.price.totalCents)}</dd>
            </div>
            {priced.price.lines.some((l) => l.key === 'minimum') ? (
              <p className="text-xs text-slate-500">
                Enthält den Mindestpreis von {formatMoney(catalog.pricing.minimumOrderCents)}.
              </p>
            ) : null}
          </dl>
        ) : priced && !priced.ok ? (
          <ul className="list-disc space-y-1 pl-4 text-rose-700">
            {priced.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ) : (
          <p className="text-slate-500">Der Preis erscheint, sobald Datei, Format, Bindung und Papier gewählt sind.</p>
        )}
      </div>
    </Card>
  )
}
