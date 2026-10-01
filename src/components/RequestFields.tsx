// Formularfelder zum Bearbeiten von Titel und Bemerkungen eines Auftrags.
// Optionen und Preis legt der Wizard fest.
import { useForm } from '@tanstack/react-form'
import { Field, Input, Textarea, fieldError } from './ui'

export type RequestFormValues = {
  title: string
  notes: string
}

export function validateRequestValues(values: RequestFormValues) {
  const fields: Partial<Record<keyof RequestFormValues, string>> = {}
  if (!values.title.trim()) fields.title = 'Titel ist erforderlich'
  return Object.keys(fields).length ? { fields } : undefined
}

export function useRequestForm(opts: {
  defaultValues: RequestFormValues
  onSubmit: (values: RequestFormValues) => Promise<void>
}) {
  return useForm({
    defaultValues: opts.defaultValues,
    validators: { onSubmit: ({ value }) => validateRequestValues(value) },
    onSubmit: ({ value }) => opts.onSubmit(value),
  })
}

export function RequestFields({ form }: { form: ReturnType<typeof useRequestForm> }) {
  return (
    <div className="space-y-4">
      <form.Field name="title">
        {(field) => (
          <Field label="Titel" htmlFor={field.name} error={fieldError(field.state.meta.errors)}>
            <Input
              id={field.name}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value)}
            />
          </Field>
        )}
      </form.Field>
      <form.Field name="notes">
        {(field) => (
          <Field label="Bemerkungen" htmlFor={field.name} error={fieldError(field.state.meta.errors)}>
            <Textarea
              id={field.name}
              rows={5}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value)}
            />
          </Field>
        )}
      </form.Field>
    </div>
  )
}
