// src/components/ui/NullableMultiSelect.tsx
// Multi-select with a "Tutti" toggle: null = applies to all, array = specific selection
// Used for applicability filters (legal_forms, regimes, ateco, etc.)

import MultiSelectChips from './MultiSelectChips'

interface Option {
  value: string
  label: string
}

interface NullableMultiSelectProps {
  options: Option[]
  value: string[] | null   // null = "Tutti"
  onChange: (val: string[] | null) => void
  label?: string
  allLabel?: string        // label for "Tutti" state (default: "Tutti")
  className?: string
}

export default function NullableMultiSelect({
  options, value, onChange, label, allLabel = 'Tutti', className,
}: NullableMultiSelectProps) {
  const isAll = value === null || value === undefined

  return (
    <div className={className}>
      {label && <p className="text-xs font-medium text-gray-600 mb-1.5">{label}</p>}
      <div className="flex items-center gap-2 mb-1.5">
        <button
          type="button"
          onClick={() => onChange(isAll ? [] : null)}
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border transition-all ${
            isAll
              ? 'bg-emerald-100 border-emerald-300 text-emerald-700'
              : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
          }`}
        >
          {isAll ? '✓' : '○'} {allLabel}
        </button>
        {!isAll && (
          <span className="text-[10px] text-gray-400">
            {value!.length === 0 ? 'Seleziona...' : `${value!.length} selezionat${value!.length === 1 ? 'o' : 'i'}`}
          </span>
        )}
      </div>
      {!isAll && (
        <MultiSelectChips
          options={options}
          value={value || []}
          onChange={onChange}
        />
      )}
    </div>
  )
}
