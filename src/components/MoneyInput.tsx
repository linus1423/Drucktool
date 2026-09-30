import { useEffect, useState } from 'react'
import { parseMoneyToCents } from '~/lib/format'
import { Input } from './ui'

function toText(cents: number | null) {
  return cents === null ? '' : (cents / 100).toFixed(2).replace('.', ',')
}

/** Eingabe in Euro ("2,50"), Wert in Cent. Leer ergibt null, wenn nullable. */
export function MoneyInput({
  id,
  value,
  onChange,
  nullable = false,
  className,
}: {
  id?: string
  value: number | null
  onChange: (cents: number | null) => void
  nullable?: boolean
  className?: string
}) {
  const [text, setText] = useState(toText(value))
  const [invalid, setInvalid] = useState(false)
  // Nur übernehmen, wenn der Wert von außen kommt, nicht beim eigenen Tippen.
  useEffect(() => {
    setText((current) => (parseMoneyToCents(current) === value ? current : toText(value)))
  }, [value])

  const parse = (t: string): { ok: boolean; cents: number | null } => {
    if (nullable && t.trim() === '') return { ok: true, cents: null }
    const cents = parseMoneyToCents(t)
    return { ok: cents !== null, cents }
  }

  return (
    <div className="relative">
      <Input
        id={id}
        inputMode="decimal"
        value={text}
        aria-invalid={invalid}
        className={`${className ?? ''} pr-7 ${invalid ? 'ring-rose-500' : ''}`}
        onChange={(e) => {
          setText(e.target.value)
          const r = parse(e.target.value)
          if (r.ok) {
            setInvalid(false)
            if (r.cents !== value) onChange(r.cents)
          }
        }}
        onBlur={() => {
          const r = parse(text)
          setInvalid(!r.ok)
          if (r.ok) setText(toText(r.cents))
        }}
      />
      <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-sm text-slate-400">€</span>
    </div>
  )
}
