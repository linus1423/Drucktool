import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { STATUS_LABELS, STATUS_TONES, type RequestStatus } from '~/lib/status'

export function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ')
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-fg hover:bg-primary-hover disabled:bg-slate-400 disabled:text-white',
  secondary: 'bg-white text-slate-900 ring-1 ring-slate-300 hover:bg-slate-100 disabled:text-slate-400',
  danger: 'bg-rose-600 text-white hover:bg-rose-500 disabled:bg-rose-300',
  ghost: 'text-slate-700 hover:bg-slate-100',
}

export function Button({
  variant = 'primary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed',
        buttonVariants[variant],
        className,
      )}
    />
  )
}

const inputBase =
  'block rounded-md border-0 bg-white px-3 py-2 text-sm text-slate-900 ring-1 ring-slate-300 ring-inset placeholder:text-slate-500 focus:ring-2 focus:ring-primary focus:outline-none disabled:bg-slate-100'

// Volle Breite, außer der Aufrufer gibt selbst eine Breite vor.
function inputClass(className?: string) {
  return cx(inputBase, !/(^|\s)(max-)?w-/.test(className ?? '') && 'w-full', className)
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={inputClass(props.className)} />
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={inputClass(props.className)} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={inputClass(cx('pr-8', props.className))} />
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string
  htmlFor?: string
  error?: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children}
      {error ? <p className="text-sm text-rose-600">{error}</p> : hint ? <p className="text-sm text-slate-500">{hint}</p> : null}
    </div>
  )
}

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cx('rounded-lg bg-white shadow-sm ring-1 ring-slate-200', className)}>
      {title || actions ? (
        <header className="flex items-center justify-between gap-4 border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          {actions}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  )
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        className ?? 'bg-slate-100 text-slate-700',
      )}
    >
      {children}
    </span>
  )
}

export function StatusBadge({ status }: { status: RequestStatus }) {
  return <Badge className={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>
}

export function Alert({ tone = 'error', children }: { tone?: 'error' | 'success' | 'info'; children: ReactNode }) {
  const tones = {
    error: 'bg-rose-50 text-rose-800 ring-rose-200',
    success: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    info: 'bg-accent-soft text-accent-strong ring-accent-ring',
  }
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cx('rounded-md px-3 py-2 text-sm ring-1', tones[tone])}>
      {children}
    </div>
  )
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}
      </div>
      {actions ? <div className="flex gap-2">{actions}</div> : null}
    </div>
  )
}

/** Gibt die erste Fehlermeldung eines TanStack-Form-Feldes als Text zurück. */
export function fieldError(errors: unknown[]): string | undefined {
  const first = errors.find(Boolean)
  if (!first) return undefined
  if (typeof first === 'string') return first
  if (typeof first === 'object' && first && 'message' in first) return String((first as { message: unknown }).message)
  return undefined
}
