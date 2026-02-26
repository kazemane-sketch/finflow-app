import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Italian number/currency/date formatters
export const fmtNum = (v: string | number | null | undefined): string => {
  if (v == null || v === '') return ''
  const n = typeof v === 'string' ? parseFloat(v) : v
  return isNaN(n) ? String(v) : n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export const fmtEur = (v: string | number | null | undefined): string => {
  if (v == null || v === '') return ''
  const n = typeof v === 'string' ? parseFloat(v) : v
  return isNaN(n) ? String(v) : n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR' })
}

export const fmtDate = (v: string | null | undefined): string => {
  if (!v) return ''
  try { return new Date(v).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' }) }
  catch { return v }
}

export const fmtDateLong = (v: string | null | undefined): string => {
  if (!v) return ''
  try { return new Date(v).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' }) }
  catch { return v }
}
