// Änderungsvorschläge der Druckerei (Issue #50): Mitarbeiter bearbeiten die Optionen eines Auftrags,
// der Kunde sieht Vorher und Nachher und stimmt zu oder lehnt ab.
import { useState } from 'react'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { EMPTY_DELIVERY, deliveryAddressSchema, type DeliveryAddress } from '~/lib/address'
import { errorMessage, isConflictError } from '~/lib/errors'
import { formatDateTime, formatMoney } from '~/lib/format'
import {
  DELIVERY_LABELS,
  DELIVERY_METHODS,
  COVER_FROM_MAIN_FILE,
  COVER_FROM_MAIN_FILE_LABELS,
  bindingChoices,
  borderlessChoice,
  coverColorChoices,
  duplexChoice,
  findFormat,
  formatSize,
  paperChoices,
  type DeliveryMethod,
  type CoverFromMainFile,
  type OrderSpec,
} from '~/lib/order'
import { calculatePrice } from '~/lib/pricing'
import { compareOrders } from '~/lib/proposal'
import { orderCatalogQuery } from '~/lib/queries'
import type { getRequestFn } from '~/server/requests/requests.functions'
import { answerChangeFn, proposeChangeFn, withdrawChangeFn } from '~/server/requests/requests.functions'
import { MoneyInput } from './MoneyInput'
import { Alert, Button, Card, Field, Input, Select, Textarea, cx } from './ui'

type Detail = Awaited<ReturnType<typeof getRequestFn>>

function int(v: string) {
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : null
}

function ConflictAlert({ error, onReload }: { error: unknown; onReload: () => void }) {
  if (!error) return null
  return (
    <Alert>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{errorMessage(error)}</span>
        {isConflictError(error) ? (
          <Button variant="secondary" onClick={onReload}>
            Neu laden
          </Button>
        ) : null}
      </div>
    </Alert>
  )
}

/** Vorher/Nachher als Tabelle; geänderte Zeilen sind hervorgehoben. */
function Comparison({ request }: { request: Detail }) {
  const rows = compareOrders(request, request.proposal!)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500">
            <th className="py-1 pr-3 font-medium" />
            <th className="py-1 pr-3 font-medium">Bisher</th>
            <th className="py-1 font-medium">Neu</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className={cx('border-t border-slate-100', r.changed && 'bg-amber-50 font-medium')}>
              <td className="py-1.5 pr-3 text-slate-500">{r.label}</td>
              <td className={cx('py-1.5 pr-3', r.changed && 'text-slate-500 line-through')}>{r.before}</td>
              <td className="py-1.5">{r.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Offener Vorschlag: Kunde stimmt zu oder lehnt ab, Mitarbeiter können ihn zurückziehen. */
export function ProposalCard({
  request,
  staff,
  onChanged,
  onEdit,
}: {
  request: Detail
  staff: boolean
  onChanged: () => Promise<void>
  onEdit: () => void
}) {
  const answer = useMutation({
    mutationFn: (accept: boolean) => answerChangeFn({ data: { id: request.id, version: request.version, accept } }),
    onSuccess: onChanged,
  })
  const withdraw = useMutation({
    mutationFn: () => withdrawChangeFn({ data: { id: request.id, version: request.version } }),
    onSuccess: onChanged,
  })
  const p = request.proposal
  if (!p) return null
  const busy = answer.isPending || withdraw.isPending
  return (
    <Card title="Änderungsvorschlag der Druckerei" className="ring-2 ring-amber-300">
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          {p.proposedByName} am {formatDateTime(p.proposedAt)}:
        </p>
        <blockquote className="border-l-4 border-amber-300 pl-3 text-sm whitespace-pre-wrap">{p.reason}</blockquote>
        <Comparison request={request} />
        <ConflictAlert error={answer.error ?? withdraw.error} onReload={() => void onChanged()} />
        {request.canAnswerProposal ? (
          <>
            <p className="text-sm text-slate-600">
              Die Änderung gilt erst, wenn Sie zustimmen. Lehnen Sie ab, bleibt der bisherige Stand und die Druckerei meldet sich.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" disabled={busy} onClick={() => answer.mutate(false)}>
                Ablehnen
              </Button>
              <Button disabled={busy} onClick={() => answer.mutate(true)}>
                Änderung annehmen ({formatMoney(p.totalCents)})
              </Button>
            </div>
          </>
        ) : staff ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-slate-500">Wartet auf die Zustimmung des Kunden.</p>
            <div className="flex gap-2">
              <Button variant="secondary" disabled={busy} onClick={onEdit}>
                Vorschlag ändern
              </Button>
              <Button variant="secondary" className="text-rose-700" disabled={busy} onClick={() => withdraw.mutate()}>
                Zurückziehen
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  )
}

type Draft = {
  spec: OrderSpec
  customWidth: string
  customHeight: string
  copies: string
  pages: string
  deliveryAddress: DeliveryAddress
  priceOverride: number | null
  reason: string
}

/** Formular für Mitarbeiter: neue Optionen, optional ein manueller Preis und eine Begründung. */
export function ProposeChangeForm({
  request,
  onDone,
  onChanged,
}: {
  request: Detail
  onDone: () => void
  onChanged: () => Promise<void>
}) {
  const { data: catalog } = useSuspenseQuery(orderCatalogQuery)
  const base = request.proposal ?? { order: request.order!, deliveryAddress: request.deliveryAddress, reason: '' }
  const start = base.order.spec
  const [draft, setDraft] = useState<Draft>(() => ({
    spec: start,
    customWidth: start.customWidthMm?.toString() ?? '',
    customHeight: start.customHeightMm?.toString() ?? '',
    copies: String(start.copies),
    pages: String(start.pages),
    deliveryAddress: base.deliveryAddress ?? EMPTY_DELIVERY,
    priceOverride:
      request.proposal && request.proposal.order.price.lines.some((l) => l.key === 'adjustment')
        ? request.proposal.totalCents
        : null,
    reason: base.reason,
  }))
  const hasCoverFile = request.files.some((f) => f.role === 'cover')

  const set = (patch: Partial<OrderSpec>) => setDraft((d) => ({ ...d, spec: { ...d.spec, ...patch } }))
  const format = findFormat(catalog, draft.spec.formatId)
  const spec: OrderSpec = {
    ...draft.spec,
    customWidthMm: format?.kind === 'custom' ? int(draft.customWidth) : null,
    customHeightMm: format?.kind === 'custom' ? int(draft.customHeight) : null,
    copies: int(draft.copies) ?? 0,
    pages: int(draft.pages) ?? 0,
    // Ohne Deckblatt-Datei kommt ein Deckblatt aus der Druckdatei (Issue #85).
    coverFromMainFile: draft.spec.coverPaperId && !hasCoverFile ? (draft.spec.coverFromMainFile ?? 'front') : null,
  }
  const size = format ? formatSize(format, spec) : null
  const binding = catalog.bindings.find((b) => b.id === spec.bindingId)
  const paper = catalog.papers.find((p) => p.id === spec.paperId)
  const coverPaper = catalog.papers.find((p) => p.id === spec.coverPaperId)
  const coverColors = coverColorChoices(catalog, binding, coverPaper)
  const duplex = duplexChoice(format, binding)
  const borderless = borderlessChoice(format, binding, paper, size)
  const priced = calculatePrice(catalog, spec)
  const addressOk = spec.delivery !== 'house_post' || deliveryAddressSchema.safeParse(draft.deliveryAddress).success

  const mutation = useMutation({
    mutationFn: () => {
      if (!priced.ok) throw new Error(priced.errors.join(' '))
      return proposeChangeFn({
        data: {
          id: request.id,
          version: request.version,
          spec,
          deliveryAddress: spec.delivery === 'house_post' ? draft.deliveryAddress : null,
          priceOverrideCents: draft.priceOverride,
          expectedTotalCents: priced.price.totalCents,
          reason: draft.reason,
        },
      })
    },
    onSuccess: async () => {
      await onChanged()
      onDone()
    },
  })

  const option = (id: string, label: string, allowed: boolean, reason?: string) => (
    <option key={id} value={id} disabled={!allowed}>
      {label}
      {!allowed && reason ? ` (${reason})` : ''}
    </option>
  )
  const addr = (key: keyof DeliveryAddress, label: string) => (
    <Field label={label} htmlFor={`proposal-${key}`}>
      <Input
        id={`proposal-${key}`}
        value={draft.deliveryAddress[key]}
        onChange={(e) => setDraft((d) => ({ ...d, deliveryAddress: { ...d.deliveryAddress, [key]: e.target.value } }))}
      />
    </Field>
  )
  const total = priced.ok ? (draft.priceOverride ?? priced.price.totalCents) : null

  return (
    <Card title="Änderung vorschlagen">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          mutation.mutate()
        }}
      >
        <p className="text-sm text-slate-600">
          Der Auftrag geht auf „Rückfrage“. Die Änderung gilt erst, wenn der Kunde zustimmt; bis dahin bleibt der bisherige Stand.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Format" htmlFor="proposal-format">
            <Select id="proposal-format" value={spec.formatId} onChange={(e) => set({ formatId: e.target.value })}>
              {catalog.formats.map((f) => option(f.id, f.label, true))}
            </Select>
          </Field>
          {format?.kind === 'custom' ? (
            <div className="flex gap-2">
              <Field label="Breite (mm)" htmlFor="proposal-width">
                <Input
                  id="proposal-width"
                  inputMode="numeric"
                  value={draft.customWidth}
                  onChange={(e) => setDraft((d) => ({ ...d, customWidth: e.target.value }))}
                />
              </Field>
              <Field label="Höhe (mm)" htmlFor="proposal-height">
                <Input
                  id="proposal-height"
                  inputMode="numeric"
                  value={draft.customHeight}
                  onChange={(e) => setDraft((d) => ({ ...d, customHeight: e.target.value }))}
                />
              </Field>
            </div>
          ) : null}
          <Field label="Bindung" htmlFor="proposal-binding">
            <Select id="proposal-binding" value={spec.bindingId} onChange={(e) => set({ bindingId: e.target.value })}>
              {bindingChoices(catalog, format).map((c) => option(c.item.id, c.item.label, c.allowed, c.reason))}
            </Select>
          </Field>
          <Field label="Papier" htmlFor="proposal-paper">
            <Select id="proposal-paper" value={spec.paperId} onChange={(e) => set({ paperId: e.target.value })}>
              {paperChoices(catalog, format, size, 'inner').map((c) =>
                option(c.item.id, `${c.item.name} ${c.item.grammage} g/m²`, c.allowed, c.reason),
              )}
            </Select>
          </Field>
          <Field label="Seiten" htmlFor="proposal-pages">
            <Input
              id="proposal-pages"
              inputMode="numeric"
              value={draft.pages}
              onChange={(e) => setDraft((d) => ({ ...d, pages: e.target.value }))}
            />
          </Field>
          <Field label="Exemplare" htmlFor="proposal-copies">
            <Input
              id="proposal-copies"
              inputMode="numeric"
              value={draft.copies}
              onChange={(e) => setDraft((d) => ({ ...d, copies: e.target.value }))}
            />
          </Field>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <label className="flex items-center gap-2" title={duplex.reason}>
            <input
              type="checkbox"
              checked={spec.duplex}
              disabled={!duplex.allowed && !spec.duplex}
              onChange={(e) => set({ duplex: e.target.checked })}
            />
            Doppelseitig
          </label>
          <label className="flex items-center gap-2" title={borderless.reason}>
            <input
              type="checkbox"
              checked={spec.borderless}
              disabled={!borderless.allowed && !spec.borderless}
              onChange={(e) => set({ borderless: e.target.checked })}
            />
            Randlos
          </label>
        </div>
        {binding?.allowsCover ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Deckblatt" htmlFor="proposal-cover">
              <Select
                id="proposal-cover"
                value={spec.coverPaperId ?? ''}
                onChange={(e) =>
                  set({
                    coverPaperId: e.target.value || null,
                    // Seitenzahl der Deckblatt-Datei, nur zur Info (Issue #87).
                    coverPages: e.target.value ? start.coverPages : null,
                  })
                }
              >
                <option value="">Kein Deckblatt</option>
                {paperChoices(catalog, format, size, 'cover')
                  .filter((c) => c.allowed)
                  .map((c) => option(c.item.id, `${c.item.name} ${c.item.grammage} g/m²`, true))}
              </Select>
            </Field>
            {spec.coverFromMainFile ? (
              <Field label="Deckblatt aus der Druckdatei" htmlFor="proposal-cover-from-main">
                <Select
                  id="proposal-cover-from-main"
                  value={spec.coverFromMainFile}
                  onChange={(e) => set({ coverFromMainFile: e.target.value as CoverFromMainFile })}
                >
                  {COVER_FROM_MAIN_FILE.map((mode) => option(mode, COVER_FROM_MAIN_FILE_LABELS[mode], true))}
                </Select>
              </Field>
            ) : null}
          </div>
        ) : null}
        {binding?.allowsCover ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Coverfarbe" htmlFor="proposal-color">
              <Select
                id="proposal-color"
                value={spec.coverColorId ?? ''}
                onChange={(e) => set({ coverColorId: e.target.value || null })}
              >
                <option value="">Standard</option>
                {coverColors.map((c) => option(c.item.id, c.item.name, c.allowed, c.reason))}
              </Select>
            </Field>
            {binding.allowsSplitCover ? (
              <Field label="Coverfarbe hinten" htmlFor="proposal-back-color">
                <Select
                  id="proposal-back-color"
                  value={spec.coverBackColorId ?? ''}
                  onChange={(e) => set({ coverBackColorId: e.target.value || null })}
                >
                  <option value="">wie vorne</option>
                  {coverColors.map((c) => option(c.item.id, c.item.name, c.allowed, c.reason))}
                </Select>
              </Field>
            ) : null}
          </div>
        ) : null}
        <Field label="Lieferung" htmlFor="proposal-delivery">
          <Select
            id="proposal-delivery"
            value={spec.delivery}
            onChange={(e) => set({ delivery: e.target.value as DeliveryMethod })}
          >
            {DELIVERY_METHODS.map((m) => (
              <option key={m} value={m}>
                {DELIVERY_LABELS[m]}
              </option>
            ))}
          </Select>
        </Field>
        {spec.delivery === 'house_post' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {addr('recipient', 'Empfänger')}
            {addr('department', 'Lehrstuhl / Einrichtung')}
            {addr('building', 'Gebäude')}
            {addr('room', 'Raum')}
          </div>
        ) : null}

        <div className="rounded-md bg-slate-50 p-3 text-sm">
          {priced.ok ? (
            <div className="space-y-3">
              <div className="flex justify-between">
                <span>Berechneter Preis</span>
                <span>{formatMoney(priced.price.totalCents)}</span>
              </div>
              <Field
                label="Preis manuell festlegen (optional)"
                htmlFor="proposal-price"
                hint="Leer lassen, um den berechneten Preis zu übernehmen. Die Differenz erscheint als Korrektur."
              >
                <MoneyInput
                  id="proposal-price"
                  nullable
                  value={draft.priceOverride}
                  onChange={(priceOverride) => setDraft((d) => ({ ...d, priceOverride }))}
                />
              </Field>
              <div className="flex justify-between text-base font-semibold">
                <span>Neuer Preis</span>
                <span>{formatMoney(total)}</span>
              </div>
              <p className="text-xs text-slate-500">Bisher: {formatMoney(request.totalCents)}</p>
            </div>
          ) : (
            <ul className="list-disc space-y-1 pl-4 text-rose-700">
              {priced.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </div>

        <Field
          label="Begründung für den Kunden"
          htmlFor="proposal-reason"
          hint="Steht in der E-Mail und über dem Vorher/Nachher-Vergleich."
        >
          <Textarea
            id="proposal-reason"
            rows={3}
            value={draft.reason}
            onChange={(e) => setDraft((d) => ({ ...d, reason: e.target.value }))}
          />
        </Field>
        <ConflictAlert error={mutation.error} onReload={() => void onChanged().then(onDone)} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onDone}>
            Abbrechen
          </Button>
          <Button type="submit" disabled={!priced.ok || !addressOk || !draft.reason.trim() || mutation.isPending}>
            Vorschlag an den Kunden senden
          </Button>
        </div>
      </form>
    </Card>
  )
}
