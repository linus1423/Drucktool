import { useState } from 'react'
import { useForm } from '@tanstack/react-form'
import { Alert, Button, Field, Input, Select, fieldError } from './ui'
import { errorMessage } from '~/lib/errors'
import { organisationSchema } from '~/lib/validation'

export type OrganisationValues = {
  name: string
  email: string
  phone: string
  street: string
  zip: string
  city: string
  country: string
  vatId: string
  costCenter: string
  status: 'pending' | 'active' | 'disabled'
}

export const emptyOrganisation: OrganisationValues = {
  name: '',
  email: '',
  phone: '',
  street: '',
  zip: '',
  city: '',
  country: 'DE',
  vatId: '',
  costCenter: '',
  status: 'active',
}

const textFields = [
  { name: 'name', label: 'Name', span: true },
  { name: 'email', label: 'E-Mail', span: false },
  { name: 'phone', label: 'Telefon', span: false },
  { name: 'street', label: 'Straße und Hausnummer', span: true },
  { name: 'zip', label: 'PLZ', span: false },
  { name: 'city', label: 'Ort', span: false },
  { name: 'country', label: 'Land (ISO-Code)', span: false },
  { name: 'vatId', label: 'USt-IdNr.', span: false },
  { name: 'costCenter', label: 'Kostenstelle', span: false },
] as const

export function OrganisationForm({
  initial,
  onSubmit,
  submitLabel,
  forCustomer = false,
}: {
  initial: OrganisationValues
  onSubmit: (values: OrganisationValues) => Promise<void>
  submitLabel: string
  /** Verwalter einer Organisation (Issue #12): Name und Status ändert nur die Druckerei. */
  forCustomer?: boolean
}) {
  const [error, setError] = useState<string | null>(null)
  const form = useForm({
    defaultValues: initial,
    validators: { onSubmit: organisationSchema },
    onSubmit: async ({ value }) => {
      setError(null)
      try {
        await onSubmit(value)
      } catch (e) {
        setError(errorMessage(e))
      }
    },
  })

  return (
    <form
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
      {textFields
        .filter((f) => !forCustomer || f.name !== 'name')
        .map((f) => (
          <form.Field key={f.name} name={f.name}>
            {(field) => (
              <div className={f.span ? 'sm:col-span-2' : ''}>
                <Field label={f.label} htmlFor={field.name} error={fieldError(field.state.meta.errors)}>
                  <Input
                    id={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                </Field>
              </div>
            )}
          </form.Field>
        ))}
      {forCustomer ? null : (
        <form.Field name="status">
          {(field) => (
            <Field label="Status" htmlFor={field.name}>
              <Select
                id={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value as OrganisationValues['status'])}
              >
                <option value="active">Aktiv</option>
                <option value="pending">Wartet auf Freigabe</option>
                <option value="disabled">Deaktiviert</option>
              </Select>
            </Field>
          )}
        </form.Field>
      )}
      <div className="flex items-end justify-end sm:col-span-2">
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" disabled={isSubmitting}>
              {submitLabel}
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  )
}
