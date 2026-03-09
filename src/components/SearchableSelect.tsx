// src/components/SearchableSelect.tsx
// Lightweight combobox: button trigger + absolute dropdown + text filter
// No external dependencies — replaces native <select> in tight table cells
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';

export interface SearchableSelectOption {
  id: string;
  label: string;
  searchText?: string; // optional override for search matching (defaults to label)
}

interface SearchableSelectProps {
  value: string | null;
  options: SearchableSelectOption[];
  onChange: (id: string | null) => void;
  placeholder?: string;       // default "—"
  emptyLabel?: string;        // label shown when no value set, e.g. "← Fatt."
  selectedClassName?: string; // classes when value is set
  emptyClassName?: string;    // classes when no value
  truncate?: number;          // max chars for trigger label (default 16)
  disabled?: boolean;
}

export default function SearchableSelect({
  value,
  options,
  onChange,
  placeholder = '\u2014',
  emptyLabel,
  selectedClassName = 'bg-blue-50 border-blue-200 text-blue-700 font-semibold',
  emptyClassName = 'border-gray-200 bg-white text-gray-500',
  truncate = 16,
  disabled = false,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Find selected option
  const selected = useMemo(() => options.find(o => o.id === value) || null, [options, value]);

  // Filtered options
  const filtered = useMemo(() => {
    if (!search.trim()) return options;
    const q = search.toLowerCase();
    return options.filter(o => (o.searchText || o.label).toLowerCase().includes(q));
  }, [options, search]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Focus input when opening
  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  const handleSelect = useCallback((id: string | null) => {
    onChange(id);
    setOpen(false);
    setSearch('');
  }, [onChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
      setSearch('');
    } else if (e.key === 'Enter' && filtered.length > 0) {
      e.preventDefault();
      handleSelect(filtered[0].id);
    }
  }, [filtered, handleSelect]);

  // Trigger label
  const triggerLabel = selected
    ? (selected.label.length > truncate ? selected.label.substring(0, truncate) + '\u2026' : selected.label)
    : (emptyLabel || placeholder);

  return (
    <div ref={containerRef} className="relative w-full">
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => { if (!disabled) { setOpen(!open); setSearch(''); } }}
        disabled={disabled}
        title={selected?.label || ''}
        className={`w-full px-1 py-1 text-[10px] border rounded-md outline-none cursor-pointer text-left truncate ${
          disabled ? 'opacity-50 cursor-not-allowed' : ''
        } ${value ? selectedClassName : emptyClassName}`}
      >
        {triggerLabel}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute z-[60] top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-xl w-[280px] overflow-hidden">
          {/* Search input */}
          <div className="p-1.5 border-b border-gray-100">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Cerca..."
              className="w-full px-2 py-1.5 text-[11px] border border-gray-200 rounded bg-gray-50 outline-none focus:ring-1 focus:ring-blue-300 focus:border-blue-300"
            />
          </div>

          {/* Options list */}
          <div className="max-h-[220px] overflow-y-auto">
            {/* Clear / none option */}
            <button
              type="button"
              onClick={() => handleSelect(null)}
              className={`w-full text-left px-3 py-1.5 text-[11px] hover:bg-gray-50 transition-colors ${
                !value ? 'bg-gray-50 font-semibold text-gray-700' : 'text-gray-400'
              }`}
            >
              {placeholder}
            </button>
            {filtered.length === 0 ? (
              <div className="px-3 py-3 text-[11px] text-gray-400 text-center">Nessun risultato</div>
            ) : (
              filtered.map(o => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => handleSelect(o.id)}
                  className={`w-full text-left px-3 py-1.5 text-[11px] hover:bg-blue-50 transition-colors ${
                    o.id === value ? 'bg-blue-50 font-semibold text-blue-700' : 'text-gray-700'
                  }`}
                >
                  {o.label}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
