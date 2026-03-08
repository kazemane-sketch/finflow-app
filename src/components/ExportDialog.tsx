// ExportDialog — Modal for configuring and downloading the Excel export
// Used in FatturePage top bar

import { useState, useCallback } from 'react'
import { X, Download, Loader2 } from 'lucide-react'
import { exportForCommercialista, type ExportFilters } from '@/lib/exportService'

interface ExportDialogProps {
  open: boolean
  onClose: () => void
  companyId: string
  companyName: string
}

export default function ExportDialog({ open, onClose, companyId, companyName }: ExportDialogProps) {
  const today = new Date()
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1)
  const [dateFrom, setDateFrom] = useState(firstOfMonth.toISOString().slice(0, 10))
  const [dateTo, setDateTo] = useState(today.toISOString().slice(0, 10))
  const [direction, setDirection] = useState<'all' | 'in' | 'out'>('all')
  const [onlyConfirmed, setOnlyConfirmed] = useState(false)
  const [includeBank, setIncludeBank] = useState(true)
  const [includeReconciliations, setIncludeReconciliations] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [progressStep, setProgressStep] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleExport = useCallback(async () => {
    setExporting(true)
    setError(null)
    try {
      const filters: ExportFilters = {
        dateFrom,
        dateTo,
        direction,
        onlyConfirmed,
        includeBank,
        includeReconciliations,
      }
      await exportForCommercialista(companyId, companyName, filters, setProgressStep)
    } catch (e: any) {
      console.error('[export]', e)
      setError(e?.message || 'Errore durante la generazione')
    } finally {
      setExporting(false)
      setProgressStep('')
    }
  }, [companyId, companyName, dateFrom, dateTo, direction, onlyConfirmed, includeBank, includeReconciliations])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="text-base font-bold text-gray-900">Export per commercialista</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* Date range */}
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">Periodo</label>
            <div className="flex items-center gap-2">
              <input
                type="date" value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                className="flex-1 px-2.5 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <span className="text-gray-400 text-xs">-</span>
              <input
                type="date" value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                className="flex-1 px-2.5 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* Direction */}
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">Direzione fatture</label>
            <div className="flex gap-2">
              {([
                { v: 'all', l: 'Tutte' },
                { v: 'in', l: 'Passive' },
                { v: 'out', l: 'Attive' },
              ] as const).map(opt => (
                <button
                  key={opt.v}
                  onClick={() => setDirection(opt.v)}
                  className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md border transition-all ${
                    direction === opt.v
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {opt.l}
                </button>
              ))}
            </div>
          </div>

          {/* Checkboxes */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox" checked={onlyConfirmed}
                onChange={e => setOnlyConfirmed(e.target.checked)}
                className="accent-blue-600"
              />
              Solo classificazioni confermate
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox" checked={includeBank}
                onChange={e => setIncludeBank(e.target.checked)}
                className="accent-blue-600"
              />
              Includi movimenti bancari (senza fattura)
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox" checked={includeReconciliations}
                onChange={e => setIncludeReconciliations(e.target.checked)}
                className="accent-blue-600"
              />
              Includi riconciliazioni
            </label>
          </div>

          {/* Error */}
          {error && (
            <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
              {error}
            </div>
          )}

          {/* Progress */}
          {exporting && progressStep && (
            <div className="flex items-center gap-2 p-2.5 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-700">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {progressStep}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t bg-gray-50 rounded-b-xl">
          <button
            onClick={handleExport}
            disabled={exporting || !dateFrom || !dateTo}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {exporting ? (
              <><Loader2 className="h-4 w-4 animate-spin" />Generazione in corso...</>
            ) : (
              <><Download className="h-4 w-4" />Scarica Excel</>
            )}
          </button>
          <p className="text-[10px] text-gray-400 text-center mt-2">
            Il file include fatture, movimenti bancari e riconciliazioni nel periodo selezionato
          </p>
        </div>
      </div>
    </div>
  )
}
