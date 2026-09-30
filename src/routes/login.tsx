import { useState } from 'react'
import { createFileRoute, Link, redirect, useRouter } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { AuthLayout } from '~/components/AuthLayout'
import { Alert, Button, Field, fieldError, Input } from '~/components/ui'
import { errorMessage } from '~/lib/errors'
import { loginSchema } from '~/lib/validation'
import { login } from '~/server/auth/auth.functions'

export const Route = createFileRoute('/login')({
  validateSearch: z.object({ redirect: z.string().optional() }),
  beforeLoad: ({ context }) => {
    if (context.user) throw redirect({ to: '/anfragen' })
  },
  head: () => ({ meta: [{ title: 'Anmelden · Drucktool' }] }),
  component: LoginPage,
})

function LoginPage() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const search = Route.useSearch()
  const [error, setError] = useState<string | null>(null)

  const form = useForm({
    defaultValues: { email: '', password: '' },
    validators: { onSubmit: loginSchema },
    onSubmit: async ({ value }) => {
      setError(null)
      try {
        await login({ data: value })
        queryClient.clear()
        // Nur relative Pfade übernehmen, damit kein Open Redirect entsteht.
        const target = search.redirect?.startsWith('/') && !search.redirect.startsWith('//') ? search.redirect : '/anfragen'
        await router.invalidate()
        await router.navigate({ href: target })
      } catch (e) {
        setError(errorMessage(e))
      }
    },
  })

  return (
    <AuthLayout title="Anmelden" subtitle="Melden Sie sich an, um Anfragen zu stellen und zu verfolgen.">
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
      <p className="mt-6 text-center text-sm text-slate-600">
        Noch kein Konto?{' '}
        <Link to="/registrieren" className="font-medium text-slate-900 underline">
          Jetzt registrieren
        </Link>
      </p>
    </AuthLayout>
  )
}
