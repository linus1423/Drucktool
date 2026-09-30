import { useState } from 'react'
import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { AuthLayout } from '~/components/AuthLayout'
import { Alert, Button, Field, fieldError, Input } from '~/components/ui'
import { errorMessage } from '~/lib/errors'
import { registerSchema } from '~/lib/validation'
import { register } from '~/server/auth/auth.functions'

export const Route = createFileRoute('/registrieren')({
  beforeLoad: ({ context }) => {
    if (context.user) throw redirect({ to: '/anfragen' })
  },
  head: () => ({ meta: [{ title: 'Registrieren · Drucktool' }] }),
  component: RegisterPage,
})

const fields = [
  { name: 'name', label: 'Ihr Name', autoComplete: 'name', type: 'text' },
  { name: 'email', label: 'E-Mail-Adresse', autoComplete: 'email', type: 'email' },
  { name: 'password', label: 'Passwort', autoComplete: 'new-password', type: 'password', hint: 'Mindestens 10 Zeichen' },
  { name: 'organisationName', label: 'Firma / Organisation', autoComplete: 'organization', type: 'text' },
  { name: 'street', label: 'Straße und Hausnummer', autoComplete: 'street-address', type: 'text' },
  { name: 'zip', label: 'PLZ', autoComplete: 'postal-code', type: 'text' },
  { name: 'city', label: 'Ort', autoComplete: 'address-level2', type: 'text' },
  { name: 'phone', label: 'Telefon', autoComplete: 'tel', type: 'tel' },
] as const

function RegisterPage() {
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const form = useForm({
    defaultValues: { name: '', email: '', password: '', organisationName: '', street: '', zip: '', city: '', phone: '' },
    validators: { onSubmit: registerSchema },
    onSubmit: async ({ value }) => {
      setError(null)
      try {
        await register({ data: value })
        setDone(true)
      } catch (e) {
        setError(errorMessage(e))
      }
    },
  })

  if (done) {
    return (
      <AuthLayout title="Vielen Dank!">
        <div className="space-y-4 text-sm text-slate-700">
          <p>
            Ihre Registrierung ist eingegangen. Wir prüfen Ihre Angaben und schalten Ihr Konto frei. Danach können Sie sich
            mit Ihrer E-Mail-Adresse anmelden.
          </p>
          <Link to="/login" className="font-medium text-slate-900 underline">
            Zur Anmeldung
          </Link>
        </div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout title="Konto registrieren" subtitle="Nach der Registrierung wird Ihr Konto von uns freigegeben.">
      <form
        method="post"
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          void form.handleSubmit()
        }}
      >
        {error ? (
          <div className="sm:col-span-2">
            <Alert>{error}</Alert>
          </div>
        ) : null}
        {fields.map((f) => (
          <form.Field key={f.name} name={f.name}>
            {(field) => (
              <div className={f.name === 'zip' || f.name === 'city' ? '' : 'sm:col-span-2'}>
                <Field
                  label={f.label}
                  htmlFor={field.name}
                  error={fieldError(field.state.meta.errors)}
                  hint={'hint' in f ? f.hint : undefined}
                >
                  <Input
                    id={field.name}
                    type={f.type}
                    autoComplete={f.autoComplete}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                </Field>
              </div>
            )}
          </form.Field>
        ))}
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" className="sm:col-span-2" disabled={isSubmitting}>
              {isSubmitting ? 'Wird gesendet …' : 'Registrieren'}
            </Button>
          )}
        </form.Subscribe>
      </form>
      <p className="mt-6 text-center text-sm text-slate-600">
        Schon registriert?{' '}
        <Link to="/login" className="font-medium text-slate-900 underline">
          Anmelden
        </Link>
      </p>
    </AuthLayout>
  )
}
