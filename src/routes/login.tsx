import { useState } from 'react'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { AuthLayout } from '~/components/AuthLayout'
import { Alert, Button, Field, fieldError, Input } from '~/components/ui'
import { errorMessage } from '~/lib/errors'
import { safeRedirect } from '~/lib/redirect'
import { emailSchema, loginSchema } from '~/lib/validation'
import { getAuthOptions, login, requestLoginLinkFn } from '~/server/auth/auth.functions'

export const Route = createFileRoute('/login')({
  validateSearch: z.object({
    redirect: z.string().optional(),
    fehler: z.string().max(300).optional(),
    hinweis: z.literal('freigabe').optional().catch(undefined),
  }),
  beforeLoad: ({ context }) => {
    if (context.user) throw redirect({ to: '/anfragen' })
  },
  loader: () => getAuthOptions(),
  head: () => ({ meta: [{ title: 'Anmelden · Drucktool' }] }),
  component: LoginPage,
})

function LoginPage() {
  const search = Route.useSearch()
  const options = Route.useLoaderData()

  return (
    <AuthLayout title="Anmelden" subtitle="Druckaufträge aufgeben und ihren Stand verfolgen.">
      <div className="space-y-6">
        {search.hinweis === 'freigabe' ? (
          <Alert tone="info">
            Ihr Konto wurde angelegt und wartet auf Freigabe. Sie erhalten eine E-Mail, sobald Sie sich anmelden können.
          </Alert>
        ) : null}
        {search.fehler ? <Alert>{search.fehler}</Alert> : null}
        <LinkLogin redirect={search.redirect ?? null} />
        <div className="flex items-center gap-3 text-xs text-slate-500 uppercase">
          <span className="h-px flex-1 bg-slate-200" />
          Mitarbeiter der Druckerei
          <span className="h-px flex-1 bg-slate-200" />
        </div>
        {options.oidc ? (
          <a
            href={`/api/auth/oidc/login${search.redirect ? `?redirect=${encodeURIComponent(search.redirect)}` : ''}`}
            className="flex w-full items-center justify-center rounded-md bg-white px-3 py-2 text-sm font-medium text-slate-900 ring-1 ring-slate-300 hover:bg-slate-100"
          >
            Anmelden mit {options.oidc.displayName}
          </a>
        ) : null}
        <details className="group text-sm">
          <summary className="cursor-pointer text-center text-slate-600 hover:text-slate-900">Mit Passwort anmelden</summary>
          <div className="mt-4">
            <PasswordLogin redirect={search.redirect} />
          </div>
        </details>
      </div>
    </AuthLayout>
  )
}

function LinkLogin({ redirect }: { redirect: string | null }) {
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const form = useForm({
    defaultValues: { email: '' },
    validators: { onSubmit: z.object({ email: emailSchema }) },
    onSubmit: async ({ value }) => {
      setError(null)
      try {
        const email = value.email.trim().toLowerCase()
        await requestLoginLinkFn({ data: { email, redirect } })
        setSentTo(email)
      } catch (e) {
        setError(errorMessage(e))
      }
    },
  })

  if (sentTo) {
    return (
      <div className="space-y-3">
        <Alert tone="success">
          Wir haben einen Anmeldelink an {sentTo} geschickt. Er ist 15 Minuten gültig. Bitte sehen Sie auch im Spam-Ordner nach.
        </Alert>
        <Button variant="ghost" className="w-full" onClick={() => setSentTo(null)}>
          Andere Adresse verwenden
        </Button>
      </div>
    )
  }

  return (
    <form
      method="post"
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        void form.handleSubmit()
      }}
    >
      {error ? <Alert>{error}</Alert> : null}
      <form.Field name="email">
        {(field) => (
          <Field
            label="E-Mail-Adresse"
            htmlFor="link-email"
            hint="Sie bekommen einen Link, mit dem Sie sich ohne Passwort anmelden. Beim ersten Mal wird Ihr Konto angelegt."
            error={fieldError(field.state.meta.errors)}
          >
            <Input
              id="link-email"
              type="email"
              autoComplete="email"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value)}
            />
          </Field>
        )}
      </form.Field>
      <form.Subscribe selector={(s) => s.isSubmitting}>
        {(isSubmitting) => (
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Wird gesendet …' : 'Anmeldelink senden'}
          </Button>
        )}
      </form.Subscribe>
    </form>
  )
}

function PasswordLogin({ redirect: target }: { redirect?: string }) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)

  const form = useForm({
    defaultValues: { email: '', password: '' },
    validators: { onSubmit: loginSchema },
    onSubmit: async ({ value }) => {
      setError(null)
      try {
        await login({ data: value })
        queryClient.clear()
        await router.invalidate()
        await router.navigate({ href: safeRedirect(target) })
      } catch (e) {
        setError(errorMessage(e))
      }
    },
  })

  return (
    <form
      method="post"
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        void form.handleSubmit()
      }}
    >
      {error ? <Alert>{error}</Alert> : null}
      <form.Field name="email">
        {(field) => (
          <Field label="E-Mail-Adresse" htmlFor={field.name} error={fieldError(field.state.meta.errors)}>
            <Input
              id={field.name}
              type="email"
              autoComplete="email"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value)}
            />
          </Field>
        )}
      </form.Field>
      <form.Field name="password">
        {(field) => (
          <Field label="Passwort" htmlFor={field.name} error={fieldError(field.state.meta.errors)}>
            <Input
              id={field.name}
              type="password"
              autoComplete="current-password"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value)}
            />
          </Field>
        )}
      </form.Field>
      <form.Subscribe selector={(s) => s.isSubmitting}>
        {(isSubmitting) => (
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Anmelden …' : 'Anmelden'}
          </Button>
        )}
      </form.Subscribe>
    </form>
  )
}
