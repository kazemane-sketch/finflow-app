// src/components/SearchableSelect.tsx
// Lightweight combobox: button trigger + Portal-based dropdown + text filter
// Uses React Portal so the dropdown escapes overflow-hidden table containers
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';

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
  const [pos, setPos] = useState<{ top: number; left: number; flip: boolean }>({ top: 0, left: 0, flip: false });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Find selected option
  const selected = useMemo(() => options.find(o => o.id === value) || null, [options, value]);

  // Filtered options
  const filtered = useMemo(() => {
    if (!search.trim()) return options;
    const q = search.toLowerCase();
    return options.filter(o => (o.searchText || o.label).toLowerCase().includes(q));
  }, [options, search]);

  // Measure trigger position for Portal dropdown
  const measure = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const dropH = 280; // approx max dropdown height
    const spaceBelow = window.innerHeight - rect.bottom;
    const flip = spaceBelow < dropH && rect.top > spaceBelow;
    setPos({
      top: flip ? rect.top : rect.bottom + 2,
      left: rect.left,
      flip,
    });
  }, []);

  // Open handler — measure then open
  const handleOpen = useCallback(() => {
    if (disabled) return;
    if (open) { setOpen(false); setSearch(''); return; }
    measure();
    setOpen(true);
    setSearch('');
  }, [disabled, open, measure]);

  // Close on outside click (check both trigger and dropdown)
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        dropdownRef.current?.contains(target)
      ) return;
      setOpen(false);
      setSearch('');
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Reposition on scroll / resize while open
  useEffect(() => {
    if (!open) return;
    const reposition = () => measure();
    window.addEventListener('scroll', reposition, true); // capture phase for nested scrollable
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, measure]);

  // Focus input when opening
  useEffect(() => {
    if (open && inputRef.current) {
      // Small timeout so portal is mounted first
      requestAnimationFrame(() => inputRef.current?.focus());
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

  // Portal dropdown
  const dropdown = open ? createPortal(
    <div
      ref={dropdownRef}
      style={{
        position: 'fixed',
        top: pos.flip ? undefined : pos.top,
        bottom: pos.flip ? (window.innerHeight - pos.top + 2) : undefined,
        left: pos.left,
        zIndex: 9999,
        minWidth: 260,
        maxWidth: 340,
      }}
      className="bg-white border border-gray-200 rounded-lg shadow-2xl overflow-hidden"
    >
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
      <div className="max-h-[240px] overflow-y-auto">
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
    </div>,
    document.body,
  ) : null;

  return (
    <div className="relative w-full">
      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        onClick={handleOpen}
        disabled={disabled}
        title={selected?.label || ''}
        className={`w-full px-1 py-1 text-[10px] border rounded-md outline-none cursor-pointer text-left truncate ${
          disabled ? 'opacity-50 cursor-not-allowed' : ''
        } ${value ? selectedClassName : emptyClassName}`}
      >
        {triggerLabel}
      </button>

      {/* Portal dropdown — rendered into document.body to escape overflow clipping */}
      {dropdown}
    </div>
  );
}
