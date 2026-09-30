// Gemeinsame Formularfelder für Anlegen und Bearbeiten einer Anfrage.
import { useForm } from '@tanstack/react-form'
import { Field, Input, Textarea, fieldError } from './ui'

export type RequestFormValues = {
  title: string
  description: string
  quantity: string
  desiredDate: string
}

export const emptyRequestValues: RequestFormValues = { title: '', description: '', quantity: '', desiredDate: '' }

export function toRequestInput(values: RequestFormValues) {
  const quantity = values.quantity.trim() ? Number(values.quantity) : null
  return {
    title: values.title,
    description: values.description,
    quantity,
    desiredDate: values.desiredDate || null,
  }
}

export function validateRequestValues(values: RequestFormValues) {
  const fields: Partial<Record<keyof RequestFormValues, string>> = {}
  if (!values.title.trim()) fields.title = 'Titel ist erforderlich'
  if (values.quantity.trim() && !(Number.isInteger(Number(values.quantity)) && Number(values.quantity) > 0)) {
    fields.quantity = 'Bitte eine ganze Zahl größer als 0 angeben'
  }
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
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <form.Field name="title">
          {(field) => (
            <Field label="Titel" htmlFor={field.name} error={fieldError(field.state.meta.errors)}>
              <Input
                id={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="z. B. Flyer DIN A5 für Frühjahrsaktion"
              />
            </Field>
          )}
        </form.Field>
      </div>
      <div className="sm:col-span-2">
        <form.Field name="description">
          {(field) => (
            <Field
              label="Beschreibung"
              htmlFor={field.name}
              error={fieldError(field.state.meta.errors)}
              hint="Format, Papier, Farbigkeit, Weiterverarbeitung und alles, was wir wissen sollten."
            >
              <Textarea
                id={field.name}
                rows={6}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            </Field>
          )}
        </form.Field>
      </div>
      <form.Field name="quantity">
        {(field) => (
          <Field label="Auflage" htmlFor={field.name} error={fieldError(field.state.meta.errors)}>
            <Input
              id={field.name}
              inputMode="numeric"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="z. B. 500"
            />
          </Field>
        )}
      </form.Field>
      <form.Field name="desiredDate">
        {(field) => (
          <Field label="Wunschtermin" htmlFor={field.name} error={fieldError(field.state.meta.errors)}>
            <Input
              id={field.name}
              type="date"
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
