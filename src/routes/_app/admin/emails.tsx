import { useMemo, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Textarea, cx } from '~/components/ui'
import { errorMessage } from '~/lib/errors'
import { formatDateTime } from '~/lib/format'
import {
  blocksToHtml,
  mailLayoutSchema,
  mailTemplateKeySchema,
  renderMail,
  unknownPlaceholders,
  type MailBlock,
  type MailBrand,
  type MailLayout,
  type MailTemplateKey,
  type StoredTemplate,
} from '~/lib/mail-templates'
import { mailTemplatesQuery } from '~/lib/queries'
import { resetMailTemplateFn, saveMailLayoutFn, saveMailTemplateFn, sendTestMailFn } from '~/server/mail/mail-templates.functions'
import { pageTitle } from '~/lib/design'

export const Route = createFileRoute('/_app/admin/emails')({
  validateSearch: z.object({ vorlage: mailTemplateKeySchema.optional().catch(undefined) }),
  loader: ({ context }) => context.queryClient.ensureQueryData(mailTemplatesQuery),
  head: ({ match }) => ({ meta: [{ title: pageTitle('E-Mails', match.context.design) }] }),
  component: MailTemplatesPage,
})

type Data = Awaited<ReturnType<NonNullable<typeof mailTemplatesQuery.queryFn>>>
type TemplateInfo = Data['templates'][number]

const BLOCK_LABELS: Record<MailBlock['kind'], string> = { p: 'Absatz', quote: 'Hervorhebung', button: 'Button' }

function useInvalidate() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: mailTemplatesQuery.queryKey })
}

function MailTemplatesPage() {
  const { data } = useSuspenseQuery(mailTemplatesQuery)
  const { vorlage } = Route.useSearch()
  const selected = data.templates.find((t) => t.key === vorlage) ?? data.templates[0]!

  return (
    <div className="space-y-6">
      <PageHeader
        title="E-Mails"
        description="Texte der automatischen Benachrichtigungen. Ohne Anpassung gelten die Standardtexte; Änderungen gelten für alle neu verschickten Mails."
      />
      <LayoutCard layout={data.layout} />
      <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
        <nav aria-label="Vorlagen" className="space-y-1">
          {data.templates.map((t) => (
            <Link
              key={t.key}
              to="/admin/emails"
              search={{ vorlage: t.key }}
              aria-current={t.key === selected.key ? 'page' : undefined}
              className={cx(
                'block rounded-md px-3 py-2 text-sm',
                t.key === selected.key ? 'bg-primary text-primary-fg' : 'text-slate-700 hover:bg-slate-100',
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span>{t.label}</span>
                {t.customized ? (
                  <Badge className={t.key === selected.key ? 'bg-primary-fg/20 text-primary-fg' : 'bg-amber-100 text-amber-800'}>
                    angepasst
                  </Badge>
                ) : null}
              </span>
              <span className={cx('block text-xs', t.key === selected.key ? 'text-primary-fg/80' : 'text-slate-500')}>
                {t.audience}
              </span>
            </Link>
          ))}
        </nav>
        <TemplateEditor key={selected.key} info={selected} layout={data.layout} brand={data.brand} />
      </div>
    </div>
  )
}

function LayoutCard({ layout }: { layout: MailLayout }) {
  const [draft, setDraft] = useState(layout)
  const invalidate = useInvalidate()
  const save = useMutation({ mutationFn: (data: MailLayout) => saveMailLayoutFn({ data }), onSuccess: invalidate })
  const parsed = mailLayoutSchema.safeParse(draft)
  const issue = (field: keyof MailLayout) =>
    parsed.success ? undefined : parsed.error.issues.find((i) => i.path[0] === field)?.message
  const set = (field: keyof MailLayout) => (e: { target: { value: string } }) => setDraft({ ...draft, [field]: e.target.value })
  const toggle = (field: 'showLogo' | 'showLegalLinks') => (e: { target: { checked: boolean } }) =>
    setDraft({ ...draft, [field]: e.target.checked })

  return (
    <Card title="Absender, Signatur und Fußzeile">
      <form
        className="grid gap-4 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (parsed.success) save.mutate(parsed.data)
        }}
      >
        <Field label="Absendername" htmlFor="layout-sender" hint="Die Absenderadresse selbst kommt aus der Serverkonfiguration.">
          <Input
            id="layout-sender"
            value={draft.senderName}
            onChange={set('senderName')}
            placeholder="z. B. Fachschaftsdruckerei"
          />
        </Field>
        <Field
          label="Antwortadresse"
          htmlFor="layout-reply"
          error={issue('replyTo')}
          hint="Leer lassen, wenn Antworten an den Absender gehen sollen."
        >
          <Input
            id="layout-reply"
            type="email"
            value={draft.replyTo}
            onChange={set('replyTo')}
            placeholder="druckerei@example.com"
          />
        </Field>
        <Field label="Kopfzeile" htmlFor="layout-header">
          <Input id="layout-header" value={draft.header} onChange={set('header')} />
        </Field>
        <Field label="Signatur" htmlFor="layout-signature">
          <Textarea id="layout-signature" rows={3} value={draft.signature} onChange={set('signature')} />
        </Field>
        <div className="md:col-span-2">
          <Field label="Fußzeile" htmlFor="layout-footer">
            <Textarea id="layout-footer" rows={2} value={draft.footer} onChange={set('footer')} />
          </Field>
        </div>
        <fieldset className="space-y-1 text-sm md:col-span-2">
          <legend className="mb-1 block font-medium text-slate-700">Aus der Design-Seite</legend>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={draft.showLogo} onChange={toggle('showLogo')} />
            Logo oben in der Mail zeigen (sofern eines hochgeladen ist)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={draft.showLegalLinks} onChange={toggle('showLegalLinks')} />
            Impressum, Datenschutz und weitere Links unter der Mail zeigen
          </label>
          <p className="text-slate-600">
            Knöpfe in Mails haben die Primärfarbe aus der{' '}
            <Link to="/admin/design" className="font-medium text-accent-strong underline">
              Design-Seite
            </Link>
            .
          </p>
        </fieldset>
        <div className="flex items-center gap-3 md:col-span-2">
          <Button type="submit" disabled={!parsed.success || save.isPending}>
            Speichern
          </Button>
          {save.isSuccess ? <span className="text-sm text-emerald-700">Gespeichert.</span> : null}
          {save.isError ? <span className="text-sm text-rose-600">{errorMessage(save.error)}</span> : null}
        </div>
      </form>
    </Card>
  )
}

function TemplateEditor({ info, layout, brand }: { info: TemplateInfo; layout: MailLayout; brand: MailBrand }) {
  const [draft, setDraft] = useState<StoredTemplate>(info.current)
  const [view, setView] = useState<'html' | 'text'>('html')
  const invalidate = useInvalidate()
  const key = info.key as MailTemplateKey
  const save = useMutation({ mutationFn: () => saveMailTemplateFn({ data: { key, template: draft } }), onSuccess: invalidate })
  const reset = useMutation({
    mutationFn: () => resetMailTemplateFn({ data: { key } }),
    onSuccess: () => {
      save.reset()
      setDraft(info.standard)
      return invalidate()
    },
  })
  const test = useMutation({ mutationFn: () => sendTestMailFn({ data: { key, template: draft } }) })

  const unknown = unknownPlaceholders(key, draft)
  const preview = useMemo(() => renderMail(draft, info.sample, layout, brand), [draft, info.sample, layout, brand])
  const dirty = JSON.stringify(draft) !== JSON.stringify(info.current)
  const differsFromStandard = JSON.stringify(draft) !== JSON.stringify(info.standard)
  const invalid =
    unknown.length > 0 || !draft.subject.trim() || (draft.mode === 'html' ? !draft.html.trim() : draft.blocks.length === 0)

  const setBlock = (index: number, block: MailBlock) =>
    setDraft({ ...draft, blocks: draft.blocks.map((b, i) => (i === index ? block : b)) })
  const moveBlock = (index: number, delta: number) => {
    const blocks = [...draft.blocks]
    const [block] = blocks.splice(index, 1)
    blocks.splice(index + delta, 0, block!)
    setDraft({ ...draft, blocks })
  }
  const addBlock = (block: MailBlock) => setDraft({ ...draft, blocks: [...draft.blocks, block] })

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Card
        title={info.label}
        actions={info.customized ? <Badge className="bg-amber-100 text-amber-800">angepasst</Badge> : <Badge>Standard</Badge>}
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            {info.description} Geht an: {info.audience}.
            {info.updatedAt ? ` Zuletzt geändert am ${formatDateTime(info.updatedAt)}.` : ''}
          </p>

          <Field label="Betreff" htmlFor="tpl-subject">
            <Input id="tpl-subject" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
          </Field>

          <fieldset>
            <legend className="mb-1 block text-sm font-medium text-slate-700">Bearbeiten als</legend>
            <div className="inline-flex rounded-md ring-1 ring-slate-300">
              {(['blocks', 'html'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={draft.mode === mode}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      mode,
                      html: mode === 'html' && !draft.html.trim() ? blocksToHtml(draft.blocks) : draft.html,
                    })
                  }
                  className={cx(
                    'px-3 py-1.5 text-sm first:rounded-l-md last:rounded-r-md',
                    draft.mode === mode ? 'bg-primary text-primary-fg' : 'text-slate-700 hover:bg-slate-100',
                  )}
                >
                  {mode === 'blocks' ? 'Bausteine' : 'HTML'}
                </button>
              ))}
            </div>
          </fieldset>

          {draft.mode === 'blocks' ? (
            <div className="space-y-3">
              {draft.blocks.map((block, index) => (
                <BlockEditor
                  key={index}
                  index={index}
                  block={block}
                  count={draft.blocks.length}
                  onChange={(b) => setBlock(index, b)}
                  onMove={(delta) => moveBlock(index, delta)}
                  onRemove={() => setDraft({ ...draft, blocks: draft.blocks.filter((_, i) => i !== index) })}
                />
              ))}
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => addBlock({ kind: 'p', text: '' })}>
                  + Absatz
                </Button>
                <Button variant="secondary" onClick={() => addBlock({ kind: 'quote', text: '' })}>
                  + Hervorhebung
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => addBlock({ kind: 'button', label: 'Auftrag öffnen', href: '{{link}}' })}
                >
                  + Button
                </Button>
                {'zusammenfassung' in info.variables ? (
                  <Button variant="secondary" onClick={() => addBlock({ kind: 'quote', text: '{{zusammenfassung}}' })}>
                    + Bestellübersicht
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <Field
              label="HTML"
              htmlFor="tpl-html"
              hint="Nur der Inhalt; Kopfzeile, Signatur und Fußzeile kommen automatisch dazu. Platzhalterwerte werden sicher eingesetzt."
            >
              <Textarea
                id="tpl-html"
                rows={14}
                className="font-mono text-xs"
                value={draft.html}
                onChange={(e) => setDraft({ ...draft, html: e.target.value })}
              />
            </Field>
          )}

          <div>
            <h3 className="text-sm font-medium text-slate-700">Platzhalter</h3>
            <p className="text-sm text-slate-500">Leere Absätze und Buttons ohne Link entfallen beim Versand.</p>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              {Object.entries(info.variables).map(([name, label]) => (
                <div key={name} className="contents">
                  <dt>
                    <code className="rounded bg-slate-100 px-1">{`{{${name}}}`}</code>
                  </dt>
                  <dd className="text-slate-600">{label}</dd>
                </div>
              ))}
            </dl>
          </div>

          {unknown.length ? (
            <Alert>
              Unbekannte Platzhalter: {unknown.map((n) => `{{${n}}}`).join(', ')}. Bitte korrigieren, sonst bleiben sie leer.
            </Alert>
          ) : null}
          {save.isError ? <Alert>{errorMessage(save.error)}</Alert> : null}
          {reset.isError ? <Alert>{errorMessage(reset.error)}</Alert> : null}
          {test.isError ? <Alert>{errorMessage(test.error)}</Alert> : null}
          {test.isSuccess ? <Alert tone="success">Testmail an {test.data.to} liegt im Postausgang.</Alert> : null}
          {save.isSuccess && !dirty ? <Alert tone="success">Vorlage gespeichert.</Alert> : null}
          {reset.isSuccess && !dirty ? <Alert tone="success">Standardtext wiederhergestellt.</Alert> : null}

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => save.mutate()} disabled={!dirty || invalid || save.isPending}>
              Speichern
            </Button>
            <Button variant="secondary" onClick={() => test.mutate()} disabled={invalid || test.isPending}>
              Testmail an mich
            </Button>
            {dirty ? (
              <Button variant="ghost" onClick={() => setDraft(info.current)}>
                Änderungen verwerfen
              </Button>
            ) : null}
            {info.customized ? (
              <Button
                variant="danger"
                disabled={reset.isPending}
                onClick={() => {
                  if (confirm('Vorlage auf den Standardtext zurücksetzen?')) reset.mutate()
                }}
              >
                Auf Standard zurücksetzen
              </Button>
            ) : differsFromStandard ? (
              <Button variant="ghost" onClick={() => setDraft(info.standard)}>
                Standardtext laden
              </Button>
            ) : null}
          </div>
        </div>
      </Card>

      <Card
        title="Vorschau mit Beispielwerten"
        actions={
          <div className="inline-flex rounded-md ring-1 ring-slate-300">
            {(['html', 'text'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className={cx(
                  'px-2 py-1 text-xs first:rounded-l-md last:rounded-r-md',
                  view === v ? 'bg-primary text-primary-fg' : 'text-slate-700 hover:bg-slate-100',
                )}
              >
                {v === 'html' ? 'HTML' : 'Text'}
              </button>
            ))}
          </div>
        }
      >
        <p className="mb-3 text-sm">
          <span className="text-slate-500">Betreff: </span>
          <span className="font-medium">{preview.subject}</span>
        </p>
        {view === 'html' ? (
          <iframe
            title="Vorschau der E-Mail"
            sandbox=""
            srcDoc={preview.html}
            className="h-[32rem] w-full rounded-md ring-1 ring-slate-200"
          />
        ) : (
          <pre className="h-[32rem] overflow-auto rounded-md bg-slate-50 p-3 text-sm whitespace-pre-wrap ring-1 ring-slate-200">
            {preview.text}
          </pre>
        )}
      </Card>
    </div>
  )
}

function BlockEditor({
  index,
  block,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  index: number
  block: MailBlock
  count: number
  onChange: (block: MailBlock) => void
  onMove: (delta: number) => void
  onRemove: () => void
}) {
  const id = `block-${index}`
  const label = `${BLOCK_LABELS[block.kind]} ${index + 1}`
  return (
    <div className="rounded-md p-3 ring-1 ring-slate-200">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium tracking-wide text-slate-600 uppercase">{label}</span>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            className="px-2 py-1"
            aria-label={`${label} nach oben`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            ↑
          </Button>
          <Button
            variant="ghost"
            className="px-2 py-1"
            aria-label={`${label} nach unten`}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            ↓
          </Button>
          <Button variant="ghost" className="px-2 py-1" aria-label={`${label} entfernen`} onClick={onRemove}>
            ✕
          </Button>
        </div>
      </div>
      {block.kind === 'button' ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Beschriftung" htmlFor={`${id}-label`}>
            <Input id={`${id}-label`} value={block.label} onChange={(e) => onChange({ ...block, label: e.target.value })} />
          </Field>
          <Field label="Link" htmlFor={`${id}-href`}>
            <Input id={`${id}-href`} value={block.href} onChange={(e) => onChange({ ...block, href: e.target.value })} />
          </Field>
        </div>
      ) : (
        <Textarea
          aria-label={label}
          rows={Math.min(8, Math.max(2, block.text.split('\n').length + 1))}
          value={block.text}
          onChange={(e) => onChange({ ...block, text: e.target.value })}
        />
      )}
    </div>
  )
}
