// Startseite mit Kennzahlen je Rolle (Issue #17).
import type { ReactNode } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { Badge, Card, PageHeader } from '~/components/ui'
import { formatMoney, formatRequestNumber } from '~/lib/format'
import { dashboardQuery } from '~/lib/queries'
import { INTERNAL_STATUS_LABELS, INTERNAL_STATUS_TONES, STATUS_LABELS } from '~/lib/status'

export const Route = createFileRoute('/_app/uebersicht')({
  loader: ({ context }) => context.queryClient.ensureQueryData(dashboardQuery),
  head: () => ({ meta: [{ title: 'Übersicht · Drucktool' }] }),
  component: DashboardPage,
})

type Dashboard = Awaited<ReturnType<NonNullable<(typeof dashboardQuery)['queryFn']>>>
type StaffDashboard = Extract<Dashboard, { kind: 'staff' }>
type CustomerDashboard = Extract<Dashboard, { kind: 'customer' }>

function DashboardPage() {
  const { data } = useSuspenseQuery(dashboardQuery)
  return data.kind === 'staff' ? <StaffView data={data} /> : <CustomerView data={data} />
}

function Stat({ label, value, to, hint }: { label: string; value: ReactNode; to?: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <div className="text-sm text-slate-600">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint ? <div className="mt-1 text-xs text-slate-500">{hint}</div> : null}
      {to ? <div className="mt-2 text-sm">{to}</div> : null}
    </div>
  )
}

const linkClass = 'font-medium text-sky-700 hover:underline'
const days = (n: number | null) => {
  if (n === null) return '–'
  if (n < 1) return 'unter einem Tag'
  return `${n.toLocaleString('de-DE', { maximumFractionDigits: 1 })} Tage`
}
const monthLabel = (m: string) => {
  const [y, mo] = m.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('de-DE', { month: 'short', year: '2-digit', timeZone: 'UTC' })
}

function StaffView({ data }: { data: StaffDashboard }) {
  const { counters, throughput } = data
  const maxCreated = Math.max(1, ...data.months.map((m) => Math.max(m.created, m.completed)))
  const year = data.months.reduce(
    (sum, m) => ({ created: sum.created + m.created, completed: sum.completed + m.completed, cents: sum.cents + m.revenueCents }),
    { created: 0, completed: 0, cents: 0 },
  )
  return (
    <div className="space-y-6">
      <PageHeader title="Übersicht" description="Auslastung und Entwicklung der Druckerei." />
      <section aria-label="Offene Aufträge" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {data.byStatus.map((s) => (
          <Stat
            key={s.status}
            label={STATUS_LABELS[s.status]}
            value={s.count}
            to={
              <div className="space-y-1">
                {s.internal.length ? (
                  <div className="flex flex-wrap gap-1">
                    {s.internal.map((i) => (
                      <Badge key={i.internalStatus} className={INTERNAL_STATUS_TONES[i.internalStatus]}>
                        {INTERNAL_STATUS_LABELS[i.internalStatus]}: {i.count}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                <Link to="/auftraege" search={{ status: s.status }} className={linkClass}>
                  Anzeigen
                </Link>
              </div>
            }
          />
        ))}
        <Stat
          label="Mir zugewiesen"
          value={counters.mine}
          to={
            <Link to="/auftraege" search={{ ansicht: 'meine' }} className={linkClass}>
              Anzeigen
            </Link>
          }
        />
        <Stat
          label="Niemand zuständig"
          value={counters.unassigned}
          to={
            <Link to="/auftraege" search={{ ansicht: 'offen', zustaendig: 'none' }} className={linkClass}>
              Anzeigen
            </Link>
          }
        />
        <Stat label="Neu seit gestern" value={counters.newSinceYesterday} hint="eingegangen seit gestern 0 Uhr" />
        <Stat label="Vorschläge beim Kunden" value={counters.proposals} hint="warten auf Zustimmung" />
      </section>

      <Card title="Durchlaufzeit">
        <p className="text-sm text-slate-700">
          Von „Eingereicht“ bis „Fertig“, über {throughput.count} in den letzten {throughput.days} Tagen fertig gewordene
          Aufträge: Median <strong>{days(throughput.medianDays)}</strong>, Durchschnitt{' '}
          <strong>{days(throughput.avgDays)}</strong>.
        </p>
      </Card>

      <Card title={`Letzte ${data.months.length} Monate`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Eingegangene und fertige Aufträge sowie Umsatz je Monat</caption>
            <thead className="text-left text-slate-600">
              <tr>
                <th className="py-1 pr-4 font-medium">Monat</th>
                <th className="py-1 pr-4 font-medium">Eingegangen</th>
                <th className="py-1 pr-4 font-medium">Fertig</th>
                <th className="py-1 pr-4 text-right font-medium">Umsatz</th>
                <th className="hidden w-1/3 py-1 font-medium sm:table-cell" aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {data.months.map((m) => (
                <tr key={m.month} className="border-t border-slate-100">
                  <td className="py-1 pr-4">{monthLabel(m.month)}</td>
                  <td className="py-1 pr-4 tabular-nums">{m.created}</td>
                  <td className="py-1 pr-4 tabular-nums">{m.completed}</td>
                  <td className="py-1 pr-4 text-right tabular-nums">{formatMoney(m.revenueCents)}</td>
                  <td className="hidden py-1 sm:table-cell" aria-hidden="true">
                    <div className="h-2 rounded bg-sky-200" style={{ width: `${(m.created / maxCreated) * 100}%` }} />
                    <div
                      className="mt-0.5 h-2 rounded bg-emerald-300"
                      style={{ width: `${(m.completed / maxCreated) * 100}%` }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-300 font-medium">
                <td className="py-1 pr-4">Summe</td>
                <td className="py-1 pr-4 tabular-nums">{year.created}</td>
                <td className="py-1 pr-4 tabular-nums">{year.completed}</td>
                <td className="py-1 pr-4 text-right tabular-nums">{formatMoney(year.cents)}</td>
                <td className="hidden sm:table-cell" />
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Umsatz: Endpreis der im Monat fertig gewordenen Aufträge. Balken: eingegangen (blau), fertig (grün).
        </p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Distribution title="Formate" rows={data.distribution.formats} />
        <Distribution title="Bindungen" rows={data.distribution.bindings} />
        <Distribution title="Papiere" rows={data.distribution.papers} />
      </div>
      <p className="text-xs text-slate-500">
        Verteilungen über die Aufträge der letzten {data.months.length} Monate, ohne abgelehnte und stornierte.
      </p>
    </div>
  )
}

function Distribution({ title, rows }: { title: string; rows: { label: string; orders: number; copies: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.orders))
  return (
    <Card title={title}>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">Noch keine Daten.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {rows.map((r) => (
            <li key={r.label}>
              <div className="flex justify-between gap-2">
                <span className="truncate">{r.label}</span>
                <span className="shrink-0 tabular-nums text-slate-600">
                  {r.orders} {r.orders === 1 ? 'Auftrag' : 'Aufträge'} · {r.copies.toLocaleString('de-DE')} Ex.
                </span>
              </div>
              <div
                className="mt-0.5 h-1.5 rounded bg-slate-300"
                style={{ width: `${(r.orders / max) * 100}%` }}
                aria-hidden="true"
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function CustomerView({ data }: { data: CustomerDashboard }) {
  const open = data.byStatus.reduce((sum, s) => sum + s.count, 0)
  return (
    <div className="space-y-6">
      <PageHeader
        title="Übersicht"
        description="Ihre offenen Aufträge auf einen Blick."
        actions={
          <Link
            to="/auftraege/neu"
            className="inline-flex items-center rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Neuer Auftrag
          </Link>
        }
      />
      <Card title="Wartet auf Ihre Antwort">
        {data.waiting.length === 0 ? (
          <p className="text-sm text-slate-600">Gerade wartet nichts auf Sie.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.waiting.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <Link to="/auftraege/$requestId" params={{ requestId: r.id }} className="font-medium hover:underline">
                  <span className="mr-1 font-mono text-slate-400">{formatRequestNumber(r.number)}</span>
                  {r.title}
                </Link>
                <span className="flex gap-1">
                  {r.status === 'on_hold' ? <Badge className="bg-amber-100 text-amber-900">Rückfrage beantworten</Badge> : null}
                  {r.hasProposal ? <Badge className="bg-amber-100 text-amber-900">Änderung zustimmen</Badge> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <section aria-label="Offene Aufträge" className="grid gap-4 sm:grid-cols-3">
        {data.byStatus.map((s) => (
          <Stat key={s.status} label={STATUS_LABELS[s.status]} value={s.count} />
        ))}
      </section>
      <p className="text-sm">
        <Link to="/auftraege" search={{ ansicht: 'offen' }} className={linkClass}>
          {open === 1 ? 'Den offenen Auftrag' : `Alle ${open} offenen Aufträge`} anzeigen
        </Link>
      </p>
    </div>
  )
}
