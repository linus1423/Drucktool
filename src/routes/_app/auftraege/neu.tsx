import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { z } from 'zod'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { FileUpload, type UploadedFile } from '~/components/FileUpload'
import { HelpTip } from '~/components/HelpTip'
import { MoneyInput } from '~/components/MoneyInput'
import { Alert, Button, Card, Field, Input, PageHeader, Select, Textarea, cx } from '~/components/ui'
import { EMPTY_DELIVERY, deliveryAddressSchema, formatDeliveryAddress, type DeliveryAddress } from '~/lib/address'
import { errorMessage } from '~/lib/errors'
import { formatMoney, formatRequestNumber } from '~/lib/format'
import {
  CUSTOM_MAX_MM,
  CUSTOM_MIN_MM,
  DELIVERY_LABELS,
  COVER_FROM_MAIN_FILE,
  COVER_FROM_MAIN_FILE_LABELS,
  coverPagesFromMainFile,
  customSizeFields,
  bindingChoices,
  bookletWarning,
  borderlessChoice,
  coverColorChoices,
  duplexChoice,
  findFormat,
  formatSize,
  paperChoices,
  suggestFormat,
  type CoverFromMainFile,
  type DeliveryMethod,
  type OrderCatalog,
  type OrderSpec,
} from '~/lib/order'
import { calculatePrice } from '~/lib/pricing'
import { accountQuery, activeOrganisationsQuery, orderCatalogQuery } from '~/lib/queries'
import { isStaffRole } from '~/lib/roles'
import { createOfferFn, createRequestFn, prepareReorderFn } from '~/server/requests/requests.functions'
import { describeScriptFn } from '~/server/scripts/scripts.functions'
import { draftFilesFn } from '~/server/files/files.functions'
import { DRAFT_VERSION, clearDraft, draftStorageKey, loadDraft, saveDraft } from '~/lib/order-draft'

export const Route = createFileRoute('/_app/auftraege/neu')({
  // ?vorlage=<id>: Nachbestellung eines früheren Auftrags (Issue #10); ?skript=<id>: Bestellung für ein Skript der SVK
  // (Issue #59), mit Vorlage als Nachbestellung, ohne als erste Bestellung.
  validateSearch: z.object({
    vorlage: z.uuid().optional().catch(undefined),
    skript: z.uuid().optional().catch(undefined),
    // Mitarbeiter legen den Auftrag als Angebot für einen Kunden an (Issue #165).
    angebot: z.boolean().optional().catch(undefined),
  }),
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
  /** Ohne Deckblatt-Datei: nur vorne oder vorne und hinten aus der Druckdatei. */
  coverFromMain: CoverFromMainFile
  coverColorId: string
  coverBackColorId: string
  borderless: boolean
  copies: string
  title: string
  notes: string
  delivery: DeliveryMethod
  deliveryAddress: DeliveryAddress
  acceptTerms: boolean
  /** Nur Mitarbeiter: Angebot an einen Kunden statt eigener Bestellung (Issue #165). */
  offer: boolean
  customerEmail: string
  customerFirstName: string
  customerLastName: string
  priceOverride: number | null
  priceReason: string
}

const int = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : null)

function pagesOf(d: Draft) {
  return d.mainFile?.pageCount ?? int(d.manualPages)
}

function coverPagesOf(d: Draft) {
  if (!d.coverEnabled) return null
  // Ohne Deckblatt-Datei gibt der Kunde an, ob es nur vorne oder vorne und hinten ist.
  return d.coverFile?.pageCount ?? null
}

/** Baut aus dem Entwurf eine Bestellung, sobald alle Pflichtangaben da sind. */
function toSpec(catalog: OrderCatalog, d: Draft): OrderSpec | null {
  const pages = pagesOf(d)
  const copies = int(d.copies)
  if (!d.formatId || !d.bindingId || !d.paperId || !pages || !copies) return null
  return {
    formatId: d.formatId,
    // Maße aus einem früher gewählten Sonderformat nicht mitschicken (Issue #117).
    ...customSizeFields(findFormat(catalog, d.formatId), int(d.customWidth), int(d.customHeight)),
    bindingId: d.bindingId,
    duplex: d.duplex,
    paperId: d.paperId,
    coverPaperId: d.coverEnabled && d.coverPaperId ? d.coverPaperId : null,
    coverPages: coverPagesOf(d),
    coverFromMainFile: d.coverEnabled && !d.coverFile ? d.coverFromMain : null,
    coverColorId: d.coverColorId || null,
    coverBackColorId: d.coverBackColorId || null,
    borderless: d.borderless,
    copies,
    pages,
    delivery: d.delivery,
  }
}

/** Das Deckblattpapier, das tatsächlich mitgeschickt wird. */
function selectedCoverPaper(catalog: OrderCatalog, d: Draft) {
  return d.coverEnabled ? catalog.papers.find((p) => p.id === d.coverPaperId) : undefined
}

/** Entfernt Auswahlen, die nach einer Änderung nicht mehr erlaubt sind. */
function normalize(catalog: OrderCatalog, d: Draft): Draft {
  const next = { ...d }
  const format = findFormat(catalog, next.formatId)
  const size = format
    ? formatSize(format, { customWidthMm: int(next.customWidth), customHeightMm: int(next.customHeight) })
    : null
  const bindings = bindingChoices(catalog, format).filter((c) => c.allowed && c.item.available)
  if (!bindings.some((c) => c.item.id === next.bindingId)) next.bindingId = ''
  // Gibt es zum Format nur eine Bindung (Plots, A6, A7, Visitenkarten: nur lose), ist sie gleich gewählt (Issue #146).
  if (!next.bindingId && bindings.length === 1) next.bindingId = bindings[0]!.item.id
  const binding = catalog.bindings.find((b) => b.id === next.bindingId)
  if (next.duplex && !duplexChoice(format, binding).allowed) next.duplex = false
  if (!paperChoices(catalog, format, size, 'inner').some((c) => c.item.id === next.paperId && c.allowed)) next.paperId = ''
  if (!binding?.allowsCover) {
    next.coverEnabled = false
    next.coverColorId = ''
    next.coverBackColorId = ''
  }
  if (!paperChoices(catalog, format, size, 'cover').some((c) => c.item.id === next.coverPaperId && c.allowed))
    next.coverPaperId = ''
  // Nach dem Deckblattpapier, weil es bestimmt, welche Coverfarben es gibt.
  const colors = coverColorChoices(catalog, binding, selectedCoverPaper(catalog, next))
  if (!colors.some((c) => c.item.id === next.coverColorId && c.allowed)) next.coverColorId = ''
  if (!binding?.allowsSplitCover || !colors.some((c) => c.item.id === next.coverBackColorId && c.allowed))
    next.coverBackColorId = ''
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
  const { vorlage, skript, angebot } = Route.useSearch()
  const script = useQuery({
    queryKey: ['scripts', 'order', skript],
    queryFn: () => describeScriptFn({ data: { id: skript! } }),
    enabled: !!skript,
    retry: false,
  })
  // POST mit Seiteneffekt (Dateikopien), deshalb nur einmal je Vorlage und ohne Wiederholung.
  const template = useQuery({
    queryKey: ['reorder', vorlage],
    queryFn: () => prepareReorderFn({ data: { id: vorlage!, scriptId: skript } }),
    enabled: !!vorlage,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const applied = useRef<string | null>(null)
  const emptyDraft = (): Draft => ({
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
    coverFromMain: 'front',
    coverColorId: '',
    coverBackColorId: '',
    borderless: false,
    copies: '1',
    title: '',
    notes: '',
    delivery: 'pickup',
    // Beim Angebot ist der Kunde der Empfänger, nicht der Mitarbeiter.
    deliveryAddress:
      staff && angebot ? EMPTY_DELIVERY : (account.deliveryAddress ?? { ...EMPTY_DELIVERY, recipient: account.name }),
    acceptTerms: false,
    offer: staff && !!angebot && !skript,
    customerEmail: '',
    customerFirstName: '',
    customerLastName: '',
    priceOverride: null,
    priceReason: '',
  })
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const initialOrganisationId = () => (!staff && user.organisations.length === 1 ? user.organisations[0]!.id : '')

  // Zwischenspeicher im Browser (Issue #175). Nachbestellungen und Skript-Bestellungen kommen aus ihrer Vorlage und
  // werden nicht gespeichert; Angebote haben einen eigenen Schlüssel. So überschreibt keiner den Entwurf des anderen.
  const draftKey = vorlage || skript ? null : draftStorageKey(user.id, staff && angebot ? 'offer' : 'order')
  // Erst speichern, wenn der Benutzer etwas eingegeben hat oder ein Entwurf wiederhergestellt ist; sonst würde das
  // leere Formular beim Öffnen einen gespeicherten Entwurf überschreiben, bevor er geladen ist.
  const touched = useRef(false)
  const [restored, setRestored] = useState<{ missingFiles: boolean } | null>(null)

  // Eine Fehlermeldung vom Absenden gilt nur für den abgeschickten Stand; sobald der Kunde etwas ändert,
  // ist sie überholt (Issue #117). Nicht per Effekt auf den Entwurf, weil normalize() nach dem Neuladen
  // des Katalogs ein neues Objekt liefert und die Meldung sonst sofort verschwände.
  const update = (patch: Partial<Draft>) => {
    setError(null)
    touched.current = true
    setDraft((d) => normalize(catalog, { ...d, ...patch }))
  }

  // Gespeicherten Entwurf nur im Browser laden; die Dateien prüft der Server (eigene, noch nicht abgeschickte Uploads).
  useEffect(() => {
    if (!draftKey) return
    const stored = loadDraft(draftKey)
    if (!stored) return
    let cancelled = false
    void (async () => {
      const wanted = { main: stored.mainFileId, cover: stored.coverFileId }
      let files: { main: UploadedFile | null; cover: UploadedFile | null } = { main: null, cover: null }
      if (wanted.main || wanted.cover) {
        try {
          files = await draftFilesFn({ data: wanted })
        } catch {
          // Ohne Antwort die Dateien weglassen; der Rest des Entwurfs ist trotzdem nützlich.
        }
      }
      // Hat der Benutzer inzwischen selbst angefangen, gilt seine Eingabe.
      if (cancelled || touched.current) return
      const base = emptyDraft()
      const next = normalize(catalog, {
        ...base,
        mainFile: files.main,
        manualPages: stored.manualPages,
        formatId: stored.formatId,
        customWidth: stored.customWidth,
        customHeight: stored.customHeight,
        bindingId: stored.bindingId,
        duplex: stored.duplex,
        paperId: stored.paperId,
        coverEnabled: stored.coverEnabled,
        coverPaperId: stored.coverPaperId,
        coverFile: files.cover,
        coverFromMain: stored.coverFromMain,
        coverColorId: stored.coverColorId,
        coverBackColorId: stored.coverBackColorId,
        borderless: stored.borderless,
        copies: stored.copies,
        title: stored.title,
        notes: stored.notes,
        delivery: stored.delivery,
        deliveryAddress: stored.deliveryAddress,
        // Die Zustimmung zu den Auftragsbedingungen gilt nur für das Absenden selbst, sie wird neu abgefragt.
        acceptTerms: false,
        offer: staff && stored.offer,
        customerEmail: stored.customerEmail,
        customerFirstName: stored.customerFirstName,
        customerLastName: stored.customerLastName,
        priceOverride: stored.priceOverride,
        priceReason: stored.priceReason,
      })
      touched.current = true
      setDraft(next)
      // Nur Organisationen, die noch zur Auswahl stehen; Mitarbeiter laden ihre Liste nach und wählen ggf. neu.
      if (staff || user.organisations.some((o) => o.id === stored.organisationId)) setOrganisationId(stored.organisationId)
      // Zum gespeicherten Schritt, höchstens bis zum ersten noch offenen (z. B. wenn eine Datei fehlt).
      const firstOpen = stepBlockers(catalog, next, null).findIndex((b) => b !== null)
      setStep(Math.min(stored.step, firstOpen === -1 ? STEPS.length - 1 : firstOpen, STEPS.length - 1))
      setRestored({ missingFiles: (!!wanted.main && !files.main) || (!!wanted.cover && !files.cover) })
    })()
    return () => {
      cancelled = true
    }
    // Nur beim Öffnen des Assistenten; der Katalog ist dann schon geladen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey])

  useEffect(() => {
    if (!draftKey || !touched.current) return
    saveDraft(draftKey, {
      version: DRAFT_VERSION,
      step,
      organisationId,
      mainFileId: draft.mainFile?.id ?? null,
      coverFileId: draft.coverFile?.id ?? null,
      manualPages: draft.manualPages,
      formatId: draft.formatId,
      customWidth: draft.customWidth,
      customHeight: draft.customHeight,
      bindingId: draft.bindingId,
      duplex: draft.duplex,
      paperId: draft.paperId,
      coverEnabled: draft.coverEnabled,
      coverPaperId: draft.coverPaperId,
      coverFromMain: draft.coverFromMain,
      coverColorId: draft.coverColorId,
      coverBackColorId: draft.coverBackColorId,
      borderless: draft.borderless,
      copies: draft.copies,
      title: draft.title,
      notes: draft.notes,
      delivery: draft.delivery,
      deliveryAddress: { ...EMPTY_DELIVERY, ...draft.deliveryAddress },
      offer: draft.offer,
      customerEmail: draft.customerEmail,
      customerFirstName: draft.customerFirstName,
      customerLastName: draft.customerLastName,
      priceOverride: draft.priceOverride,
      priceReason: draft.priceReason,
    })
  }, [draftKey, draft, step, organisationId])

  /** Löscht den gespeicherten Entwurf und speichert nichts mehr, bis wieder etwas eingegeben wird. */
  const forgetDraft = () => {
    touched.current = false
    if (draftKey) clearDraft(draftKey)
  }

  /** Verwirft den gespeicherten Entwurf und beginnt mit einem leeren Assistenten. */
  const startOver = () => {
    forgetDraft()
    setError(null)
    setRestored(null)
    setDraft(emptyDraft())
    setOrganisationId(initialOrganisationId())
    setStep(0)
  }

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
        // Ohne kopierte Deckblatt-Datei kommt das Deckblatt wieder aus der Druckdatei.
        coverEnabled: !!s.coverPaperId,
        coverPaperId: s.coverPaperId ?? '',
        coverFile: t.coverFile,
        coverFromMain: s.coverFromMainFile ?? 'front',
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
  // Erste Bestellung eines Skripts: Titel aus dem Skript übernehmen.
  const scriptTitle = script.data && !vorlage ? `${script.data.title} (${script.data.semester})` : null
  useEffect(() => {
    if (scriptTitle) setDraft((d) => (d.title ? d : { ...d, title: scriptTitle }))
  }, [scriptTitle])
  // Katalog kann sich nach "Preis geändert" neu laden; Auswahlen dann erneut prüfen.
  useEffect(() => setDraft((d) => normalize(catalog, d)), [catalog])

  const format = findFormat(catalog, draft.formatId)
  const size = format
    ? formatSize(format, { customWidthMm: int(draft.customWidth), customHeightMm: int(draft.customHeight) })
    : null
  const binding = catalog.bindings.find((b) => b.id === draft.bindingId)
  const paper = catalog.papers.find((p) => p.id === draft.paperId)
  const spec = toSpec(catalog, draft)
  const priced = useMemo(() => (spec ? calculatePrice(catalog, spec) : null), [catalog, spec && JSON.stringify(spec)])

  const blockers = stepBlockers(catalog, draft, priced?.ok ? priced.price.totalCents : null)
  const firstBlocked = blockers.findIndex((b) => b !== null)
  const canOpen = (i: number) => firstBlocked === -1 || i <= firstBlocked

  const submit = async () => {
    if (!spec || !priced?.ok || !draft.mainFile) return
    setError(null)
    setSubmitting(true)
    try {
      if (draft.offer) {
        const offered = await createOfferFn({
          data: {
            customer: { email: draft.customerEmail, firstName: draft.customerFirstName, lastName: draft.customerLastName },
            title: draft.title,
            notes: draft.notes,
            spec,
            mainFileId: draft.mainFile.id,
            coverFileId: draft.coverEnabled && draft.coverFile ? draft.coverFile.id : null,
            deliveryAddress: draft.delivery === 'house_post' ? draft.deliveryAddress : null,
            expectedTotalCents: priced.price.totalCents,
            priceOverrideCents: draft.priceOverride,
            priceReason: draft.priceReason,
          },
        })
        forgetDraft()
        await queryClient.invalidateQueries({ queryKey: ['requests'] })
        await navigate({ to: '/auftraege/$requestId', params: { requestId: offered.id } })
        return
      }
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
          organisationId: script.data?.organisationId ?? (organisationId || undefined),
          reorderOfId: template.data?.source.id,
          scriptId: script.data?.id,
        },
      })
      forgetDraft()
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
        title={draft.offer ? 'Neues Angebot' : 'Neuer Auftrag'}
        description={
          draft.offer
            ? 'Auftrag für einen Kunden anlegen, der vorbeigekommen ist oder geschrieben hat. Der Kunde bekommt eine E-Mail und nimmt das Angebot im Drucktool an.'
            : 'Schritt für Schritt zum Druckauftrag. Verbindlich wird er erst, wenn die Druckerei ihn bestätigt.'
        }
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

      {skript ? (
        <div className="mb-4">
          {script.error ? (
            <Alert>{errorMessage(script.error)}</Alert>
          ) : script.data ? (
            <Alert tone="info">
              Bestellung für das Skript{' '}
              <Link to="/skripte" className="underline">
                {script.data.title} ({script.data.semester})
              </Link>
              . Fertig gedruckte Exemplare kommen in den Bestand der SVK.
            </Alert>
          ) : null}
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
      {restored ? (
        <div className="mb-4">
          <Alert tone="info">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                Entwurf wiederhergestellt.
                {restored.missingFiles
                  ? ' Hochgeladene Dateien sind nicht mehr vorhanden, bitte erneut hochladen.'
                  : ' Ihre letzten Eingaben sind übernommen.'}
              </span>
              <Button variant="secondary" onClick={startOver}>
                Neu beginnen
              </Button>
            </div>
          </Alert>
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
                  offerField={
                    staff && !skript ? (
                      <OfferFields draft={draft} update={update} calculatedCents={priced?.ok ? priced.price.totalCents : null} />
                    ) : null
                  }
                  organisationField={
                    draft.offer ? null : script.data ? (
                      <p className="text-sm text-slate-600">
                        Bestellt für die SVK <strong>{script.data.organisationName}</strong>.
                      </p>
                    ) : staff || organisations.length > 0 ? (
                      <Field label="Organisation (optional)" htmlFor="organisationId">
                        <Select
                          id="organisationId"
                          value={organisationId}
                          onChange={(e) => {
                            setError(null)
                            touched.current = true
                            setOrganisationId(e.target.value)
                          }}
                        >
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
                    {submitting
                      ? 'Wird gesendet …'
                      : draft.offer
                        ? 'Angebot an den Kunden senden'
                        : 'Auftrag verbindlich absenden'}
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
function stepBlockers(catalog: OrderCatalog, d: Draft, calculatedCents: number | null): (string | null)[] {
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
  }
  const copies = int(d.copies)
  const options = !d.title.trim()
    ? 'Bitte einen Titel angeben.'
    : !copies || copies < 1
      ? 'Bitte die Anzahl der Exemplare angeben.'
      : null
  const address = d.delivery === 'house_post' ? deliveryAddressSchema.safeParse(d.deliveryAddress) : null
  const delivery = address && !address.success ? `${address.error.issues[0]!.message}.` : null
  const terms = d.offer ? offerBlocker(d, calculatedCents) : !d.acceptTerms ? 'Bitte den Auftragsbedingungen zustimmen.' : null
  return [file, fmt, bind, paper, options, delivery, terms]
}

function offerBlocker(d: Draft, calculatedCents: number | null) {
  if (!z.email().safeParse(d.customerEmail.trim()).success) return 'Bitte die E-Mail-Adresse des Kunden angeben.'
  if (!d.customerLastName.trim()) return 'Bitte den Nachnamen des Kunden angeben.'
  if (d.priceOverride != null && d.priceOverride !== calculatedCents && !d.priceReason.trim()) {
    return 'Bitte den abweichenden Preis für den Kunden begründen.'
  }
  return null
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
        'rounded-lg p-3 text-left text-sm ring-1 transition-shadow',
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
  const coverPaper = selectedCoverPaper(catalog, draft)
  const colors = coverColorChoices(catalog, binding, coverPaper)
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
              Das Deckblatt können Sie als eigene PDF mit beliebig vielen Seiten hochladen. Ohne eigene Datei nehmen wir die
              ersten bzw. letzten zwei Seiten Ihrer Druckdatei. Jedes Deckblatt wird beidseitig auf das gewählte Papier gedruckt
              und als ein Blatt berechnet.
            </HelpTip>
          </label>
          {draft.coverEnabled ? (
            <>
              {paperList('cover', draft.coverPaperId, (coverPaperId) => update({ coverPaperId }))}
              <FileUpload
                role="cover"
                label="Deckblatt (optional)"
                value={draft.coverFile}
                onChange={(coverFile) => update({ coverFile })}
              />
              {draft.coverFile ? null : <CoverFromMainFileNote draft={draft} />}
              {draft.coverFile ? null : (
                <Field label="Deckblatt aus der Druckdatei" htmlFor="coverFromMain">
                  <Select
                    id="coverFromMain"
                    className="w-48"
                    value={draft.coverFromMain}
                    onChange={(e) => update({ coverFromMain: e.target.value as CoverFromMainFile })}
                  >
                    {COVER_FROM_MAIN_FILE.map((mode) => (
                      <option key={mode} value={mode}>
                        {COVER_FROM_MAIN_FILE_LABELS[mode]}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={binding.allowsSplitCover ? 'Coverfarbe vorne' : 'Coverfarbe'}
              htmlFor="coverColor"
              hint={coverPaper ? `Farben, die es auf ${coverPaper.name} ${coverPaper.grammage} g/m² gibt.` : undefined}
            >
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

/** Erklärt, was ohne eigene Deckblatt-Datei gedruckt wird (Issue #85). */
function CoverFromMainFileNote({ draft }: { draft: Draft }) {
  const pages = pagesOf(draft)
  const fromMain = pages ? coverPagesFromMainFile({ coverFromMainFile: draft.coverFromMain, pages }) : null
  const which = fromMain
    ? fromMain.back
      ? `${fromMain.front} für das vordere und ${fromMain.back} für das hintere Deckblatt`
      : `${fromMain.front} für das vordere Deckblatt`
    : draft.coverFromMain === 'frontBack'
      ? 'die ersten zwei Seiten für das vordere und die letzten zwei Seiten für das hintere Deckblatt'
      : 'die ersten zwei Seiten für das vordere Deckblatt'
  return (
    <Alert tone="info">
      Ohne eigene Deckblatt-Datei drucken wir {which} aus Ihrer Druckdatei beidseitig auf das Deckblattpapier, auch bei
      einseitigem Druck. Diese Seiten werden nicht zusätzlich im Innenteil gedruckt. Bitte legen Sie die Druckdatei entsprechend
      an.
    </Alert>
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

/** Kunde und Preis für ein Angebot der Druckerei (Issue #165). */
function OfferFields({
  draft,
  update,
  calculatedCents,
}: Pick<StepProps, 'draft' | 'update'> & { calculatedCents: number | null }) {
  return (
    <fieldset className="space-y-3 rounded-md border border-slate-200 p-3">
      <legend className="px-1 text-sm font-medium">Für wen?</legend>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="radio" name="offer" checked={!draft.offer} onChange={() => update({ offer: false })} />
          Eigene Bestellung
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="offer" checked={draft.offer} onChange={() => update({ offer: true })} />
          Angebot an einen Kunden
        </label>
      </div>
      {draft.offer ? (
        <>
          <Field
            label="E-Mail-Adresse des Kunden"
            htmlFor="customerEmail"
            hint="Gibt es noch kein Konto, wird eins angelegt. Der Kunde meldet sich mit dieser Adresse an."
          >
            <Input
              id="customerEmail"
              type="email"
              autoComplete="off"
              value={draft.customerEmail}
              onChange={(e) => update({ customerEmail: e.target.value })}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Vorname" htmlFor="customerFirstName">
              <Input
                id="customerFirstName"
                autoComplete="off"
                value={draft.customerFirstName}
                onChange={(e) => update({ customerFirstName: e.target.value })}
              />
            </Field>
            <Field label="Nachname" htmlFor="customerLastName">
              <Input
                id="customerLastName"
                autoComplete="off"
                value={draft.customerLastName}
                onChange={(e) => update({ customerLastName: e.target.value })}
              />
            </Field>
          </div>
          <Field
            label="Preis manuell festlegen (optional)"
            htmlFor="offerPrice"
            hint={`Leer lassen, um den berechneten Preis${calculatedCents != null ? ` von ${formatMoney(calculatedCents)}` : ''} zu übernehmen. Die Differenz erscheint als Korrektur.`}
          >
            <MoneyInput
              id="offerPrice"
              nullable
              value={draft.priceOverride}
              onChange={(priceOverride) => update({ priceOverride })}
            />
          </Field>
          {draft.priceOverride != null && draft.priceOverride !== calculatedCents ? (
            <Field label="Begründung für den Kunden" htmlFor="priceReason">
              <Textarea
                id="priceReason"
                rows={2}
                value={draft.priceReason}
                onChange={(e) => update({ priceReason: e.target.value })}
              />
            </Field>
          ) : null}
          <p className="text-sm text-slate-600">
            Der Kunde bekommt eine E-Mail mit dem Angebot. Er hinterlegt seine Rechnungsadresse, stimmt den Auftragsbedingungen zu
            und nimmt an; dann ist der Auftrag bestätigt.
          </p>
        </>
      ) : null}
    </fieldset>
  )
}

function SubmitStep({
  draft,
  update,
  catalog,
  organisationField,
  offerField,
}: StepProps & { organisationField: ReactNode; offerField: ReactNode }) {
  return (
    <>
      {offerField}
      {organisationField}
      {draft.offer ? null : <SubmitTerms draft={draft} update={update} catalog={catalog} />}
      <dl className="space-y-2 rounded-md border border-slate-200 p-3 text-sm">
        <div>
          <dt className="text-slate-500">Titel</dt>
          <dd>{draft.title.trim() || '–'}</dd>
        </div>
        {draft.notes.trim() ? (
          <div>
            <dt className="text-slate-500">Bemerkungen</dt>
            <dd className="whitespace-pre-line">{draft.notes.trim()}</dd>
          </div>
        ) : null}
        <div>
          <dt className="text-slate-500">{DELIVERY_LABELS[draft.delivery]}</dt>
          <dd>
            {draft.delivery === 'house_post'
              ? formatDeliveryAddress(draft.deliveryAddress).map((line) => <div key={line}>{line}</div>)
              : draft.offer
                ? 'Der Kunde holt den Auftrag im Regal der Druckerei ab.'
                : 'Sie holen den Auftrag im Regal der Druckerei ab.'}
          </dd>
        </div>
      </dl>
      {draft.offer ? null : (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={draft.acceptTerms}
            onChange={(e) => update({ acceptTerms: e.target.checked })}
          />
          <span>Ich habe die Auftragsbedingungen gelesen und stimme ihnen zu.</span>
        </label>
      )}
      {catalog.texts.turnaround ? <p className="text-sm text-slate-500">{catalog.texts.turnaround}</p> : null}
    </>
  )
}

function SubmitTerms({ catalog }: StepProps) {
  return (
    <>
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
    </>
  )
}

/** Zeilen der Preisvorschau, die nur erscheinen, wenn der Kunde die Option gewählt hat. */
function optionalRows(catalog: OrderCatalog, draft: Draft): [string, string][] {
  const rows: [string, string][] = []
  const coverPaper = selectedCoverPaper(catalog, draft)
  if (coverPaper) {
    const source = draft.coverFile ? 'eigene Datei' : COVER_FROM_MAIN_FILE_LABELS[draft.coverFromMain]
    rows.push(['Deckblatt', `${coverPaper.name}, ${source}`])
  }
  const color = (id: string) => catalog.coverColors.find((c) => c.id === id)?.name
  const front = color(draft.coverColorId)
  const back = color(draft.coverBackColorId)
  if (front || back) rows.push(['Coverfarbe', back && back !== front ? `vorne ${front ?? 'Standard'}, hinten ${back}` : front!])
  if (draft.borderless) rows.push(['Randlos', 'ja'])
  return rows
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
  const spec = toSpec(catalog, draft)
  // Nur ein Hinweis: fehlende Seiten ergänzt die Druckerei als Leerseiten (Issue #103).
  const warning = priced?.ok && spec ? bookletWarning(spec) : null
  const rows: [string, string | undefined][] = [
    ['Datei', draft.mainFile ? `${draft.mainFile.filename}${pages ? `, ${pages} S.` : ''}` : undefined],
    [
      'Format',
      formatLabel &&
        (findFormat(catalog, draft.formatId)?.kind === 'custom' && size ? `${size.widthMm} × ${size.heightMm} mm` : formatLabel),
    ],
    ['Bindung', bindingLabel && `${bindingLabel}, ${draft.duplex ? 'doppelseitig' : 'einseitig'}`],
    ['Papier', paperLabel],
    // Deckblatt, Coverfarbe und randlos ändern Ware und Preis, deshalb stehen sie mit in der Übersicht (Issue #145).
    ...optionalRows(catalog, draft),
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
          <>
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
            </dl>
            {warning ? <p className="mt-1 text-xs text-amber-700">{warning}</p> : null}
            {priced.price.lines.some((l) => l.key === 'minimum') ? (
              <p className="mt-1 text-xs text-slate-500">
                Enthält den Mindestpreis von {formatMoney(catalog.pricing.minimumOrderCents)}.
              </p>
            ) : null}
          </>
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
