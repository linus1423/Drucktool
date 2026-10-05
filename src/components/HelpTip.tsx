import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

/**
 * Info-Symbol mit Hilfetext (Issue #51). Öffnet per Klick, Tippen oder Tastatur,
 * auf dem Desktop zusätzlich beim Überfahren mit der Maus.
 */
export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const id = useId()
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) {
        setOpen(false)
        setPinned(false)
      }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  return (
    <span
      ref={ref}
      className="relative inline-flex align-middle"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => !pinned && setOpen(false)}
    >
      <button
        type="button"
        aria-label={`Hilfe: ${label}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setPinned(!pinned)
          setOpen(!pinned)
        }}
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-slate-200 text-[10px] font-bold text-slate-600 hover:bg-slate-300 focus:ring-2 focus:ring-primary focus:outline-none"
      >
        ?
      </button>
      {open ? (
        <span
          id={id}
          role="tooltip"
          className="absolute top-6 left-1/2 z-20 w-64 max-w-[80vw] -translate-x-1/2 rounded-md bg-slate-900 px-3 py-2 text-left text-xs leading-relaxed font-normal text-white shadow-lg"
        >
          {children}
        </span>
      ) : null}
    </span>
  )
}
