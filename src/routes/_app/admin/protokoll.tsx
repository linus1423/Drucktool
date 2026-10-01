import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { Button, Card, Field, Input, PageHeader, Select } from '~/components/ui'
import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_LABELS,
  AUDIT_FIELD_LABELS,
  LOGIN_FAILURE_LABELS,
  LOGIN_METHOD_LABELS,
  type AuditAction,
} from '~/lib/audit'
import { formatDateTime } from '~/lib/format'
import { MAIL_TEMPLATES, type MailTemplateKey } from '~/lib/mail-templates'
import { auditLogQuery, organisationsQuery, usersQuery } from '~/lib/queries'
import { ROLE_LABELS, USER_STATUS_LABELS, ORG_STATUS, type UserRole, type UserStatus } from '~/lib/roles'

const searchSchema = z.object({
  benutzer: z.uuid().optional().catch(undefined),
  organisation: z.uuid().optional().catch(undefined),
  aktion: z.enum(AUDIT_ACTIONS).optional().catch(undefined),
  von: z.iso.date().optional().catch(undefined),
  bis: z.iso.date().optional().catch(undefined),
  seite: z.number().int().min(0).optional().catch(undefined),
})
type Search = z.infer<typeof searchSchema>

function toFilter(search: Search) {
  return {
    userId: search.benutzer,
    organisationId: search.organisation,
    action: search.aktion,
    from: search.von,
    to: search.bis,
    page: search.seite ?? 0,
  }
}

export const Route = createFileRoute('/_app/admin/protokoll')({
  beforeLoad: ({ context }) => {
    if (context.user.role !== 'superadmin') throw redirect({ to: '/auftraege' })
  },
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(auditLogQuery(toFilter(deps))),
  head: () => ({ meta: [{ title: 'Protokoll · Drucktool' }] }),
  component: AuditLogPage,
})

type Entry = Awaited<ReturnType<NonNullable<ReturnType<typeof auditLogQuery>['queryFn']>>>['entries'][number]

function AuditLogPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { data } = useSuspenseQuery(auditLogQuery(toFilter(search)))
  const users = useQuery(usersQuery)
  const organisations = useQuery(organisationsQuery)
  const page = search.seite ?? 0
  const orgName = (id: string) => organisations.data?.find((o) => o.id === id)?.name ?? 'Organisation'
  const set = (patch: Partial<Search>) => navigate({ search: (prev) => ({ ...prev, ...patch, seite: undefined }) })

  return (
    <>
      <PageHeader
        title="Protokoll"
        description="Admin-Aktionen und Anmeldungen. Passwörter werden nie protokolliert; alte Einträge werden nach der eingestellten Frist gelöscht."
      />
      <Card className="mb-4">
        <div className="grid gap-3 md:grid-cols-5">
          <Field label="Benutzer" htmlFor="audit-user">
            <Select
              id="audit-user"
              value={search.benutzer ?? ''}
              onChange={(e) => set({ benutzer: e.target.value || undefined })}
            >
              <option value="">Alle</option>
              {users.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Organisation" htmlFor="audit-org">
            <Select
              id="audit-org"
              value={search.organisation ?? ''}
              onChange={(e) => set({ organisation: e.target.value || undefined })}
            >
              <option value="">Alle</option>
              {organisations.data?.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Aktion" htmlFor="audit-action">
            <Select
              id="audit-action"
              value={search.aktion ?? ''}
              onChange={(e) => set({ aktion: (e.target.value || undefined) as AuditAction | undefined })}
            >
              <option value="">Alle</option>
              {AUDIT_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {AUDIT_ACTION_LABELS[a]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Von" htmlFor="audit-from">
            <Input
              id="audit-from"
              type="date"
              value={search.von ?? ''}
              onChange={(e) => set({ von: e.target.value || undefined })}
            />
          </Field>
          <Field label="Bis" htmlFor="audit-to">
            <Input
              id="audit-to"
              type="date"
              value={search.bis ?? ''}
              onChange={(e) => set({ bis: e.target.value || undefined })}
            />
          </Field>
        </div>
      </Card>
      <Card>
        {data.entries.length === 0 ? (
          <p className="text-sm text-slate-500">Keine Einträge für diese Auswahl.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {data.entries.map((e) => (
              <AuditRow key={e.id} entry={e} orgName={orgName} />
            ))}
          </ul>
        )}
        <div className="mt-4 flex justify-between">
          <Button
            variant="secondary"
            disabled={page === 0}
            onClick={() => navigate({ search: (prev) => ({ ...prev, seite: page > 1 ? page - 1 : undefined }) })}
          >
            Neuere
          </Button>
          <Button
            variant="secondary"
            disabled={!data.hasMore}
            onClick={() => navigate({ search: (prev) => ({ ...prev, seite: page + 1 }) })}
          >
            Ältere
          </Button>
        </div>
      </Card>
    </>
  )
}

type OrgName = (id: string) => string

function label(key: string, value: unknown, orgName: OrgName) {
  if (value === null || value === undefined || value === '') return '–'
  if (key === 'role' && typeof value === 'string') return ROLE_LABELS[value as UserRole] ?? value
  if (key === 'status' && typeof value === 'string') {
    return USER_STATUS_LABELS[value as UserStatus] ?? ORG_STATUS[value as keyof typeof ORG_STATUS]?.label ?? value
  }
  if (key === 'organisationId' && typeof value === 'string') return orgName(value)
  if (key === 'organisationIds' && Array.isArray(value)) return value.length ? value.map((v) => orgName(String(v))).join(', ') : 'keine'
  return String(value)
}

function describeChanges(before: Record<string, unknown> | null, after: Record<string, unknown> | null, orgName: OrgName) {
  if (!after) return null
  const text = (k: string, v: unknown) => label(k, v, orgName)
  if (!before) {
    return Object.entries(after)
      .filter(([, v]) => v !== null && v !== '')
      .map(([k, v]) => `${AUDIT_FIELD_LABELS[k] ?? k}: ${text(k, v)}`)
      .join(', ')
  }
  const changed = Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
  return changed.map((k) => `${AUDIT_FIELD_LABELS[k] ?? k}: ${text(k, before[k])} → ${text(k, after[k])}`).join(', ')
}

function describeDetails(e: Entry) {
  const data = e.data as Record<string, unknown>
  const parts: string[] = []
  if (typeof data.method === 'string') parts.push(`über ${LOGIN_METHOD_LABELS[data.method] ?? data.method}`)
  if (typeof data.reason === 'string') parts.push(LOGIN_FAILURE_LABELS[data.reason] ?? data.reason)
  if (typeof data.email === 'string') parts.push(data.email)
  if (data.passwordChanged === true) parts.push('Passwort neu gesetzt')
  if (data.passwordSet === true) parts.push('mit Passwort')
  if (data.sessionsRevoked === true) parts.push('Sitzungen beendet')
  if (data.existingOrganisation === true) parts.push('bestehender Organisation zugeordnet')
  if (typeof data.requested === 'string') parts.push(`angefragt: „${data.requested}“`)
  if (data.created === true || data.fromRequest === true) parts.push('neu angelegt aus Anfrage')
  return parts.join(' · ')
}

function AuditRow({ entry: e, orgName }: { entry: Entry; orgName: OrgName }) {
  const action = AUDIT_ACTION_LABELS[e.action as AuditAction] ?? e.action
  const target =
    e.targetType === 'user'
      ? (e.targetUserName ?? (e.targetId ? 'Gelöschter Benutzer' : null))
      : e.targetType === 'organisation'
        ? (e.organisationName ?? 'Gelöschte Organisation')
        : e.targetType === 'mail_template'
          ? e.targetId
            ? (MAIL_TEMPLATES[e.targetId as MailTemplateKey]?.label ?? e.targetId)
            : 'Absender, Signatur und Fußzeile'
          : null
  // Vorlagen bestehen aus Bausteinen; den Inhalt zeigt die Seite „E-Mails“, hier nur, dass sich etwas geändert hat.
  const changes = e.targetType === 'mail_template' ? null : describeChanges(e.before, e.after, orgName)
  const details = describeDetails(e)
  const failed = e.action === 'login.failed'
  return (
    <li className="py-2">
      <div>
        <span className={failed ? 'font-medium text-rose-700' : 'font-medium'}>{action}</span>
        {target ? <> · {target}</> : null}
        {e.targetType === 'user' && e.organisationName ? <span className="text-slate-500"> ({e.organisationName})</span> : null}
      </div>
      {changes ? <div className="break-all text-slate-600">{changes}</div> : null}
      {details ? <div className="text-slate-600">{details}</div> : null}
      <div className="text-xs text-slate-500">
        {formatDateTime(e.createdAt)}
        {e.actorName && e.actorId !== e.targetId ? ` · durch ${e.actorName}` : ''}
        {e.ip ? ` · IP ${e.ip}` : ''}
      </div>
    </li>
  )
}
