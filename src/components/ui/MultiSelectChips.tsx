// src/components/ui/MultiSelectChips.tsx
// Reusable chip-based multi-select for fixed option sets
// Used for tax_area, accounting_area, legal_forms, regimes, operations, etc.

interface Option {
  value: string
  label: string
}

interface MultiSelectChipsProps {
  options: Option[]
  value: string[]
  onChange: (val: string[]) => void
  label?: string
  className?: string
  size?: 'sm' | 'md'
}

export default function MultiSelectChips({
  options, value, onChange, label, className, size = 'sm',
}: MultiSelectChipsProps) {
  const toggle = (v: string) => {
    onChange(value.includes(v) ? value.filter(x => x !== v) : [...value, v])
  }

  const chipBase = size === 'sm'
    ? 'px-2 py-0.5 text-[11px]'
    : 'px-2.5 py-1 text-xs'

  return (
    <div className={className}>
      {label && <p className="text-xs font-medium text-gray-600 mb-1.5">{label}</p>}
      <div className="flex flex-wrap gap-1">
        {options.map(o => {
          const active = value.includes(o.value)
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => toggle(o.value)}
              className={`rounded-full border font-medium transition-all ${chipBase} ${
                active
                  ? 'bg-sky-100 border-sky-300 text-sky-700'
                  : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-700'
              }`}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
