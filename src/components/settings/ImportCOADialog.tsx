// src/components/settings/ImportCOADialog.tsx — Import chart of accounts from balance sheet PDF
import { useState, useRef, useCallback } from 'react'
import { X, Upload, FileText, Loader2, CheckCircle, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '@/integrations/supabase/client'
import { SECTION_LABELS, type CoaSection } from '@/lib/classificationService'
import { deriveLevel } from '@/lib/coaTemplateService'
import { triggerEntityEmbedding } from '@/lib/companyMemoryService'
import { toast } from 'sonner'

// ─── Types ────────────────────────────────────────────────

interface ExtractedAccount {
  code: string
  name: string
  section: string
  is_header: boolean
  amount: number | null
}

interface AccountRow extends ExtractedAccount {
  selected: boolean
  existing: boolean
}

type DialogState = 'idle' | 'uploading' | 'preview' | 'importing' | 'done' | 'error'

interface Props {
  companyId: string
  existingCodes: Set<string>
  open: boolean
  onClose: () => void
  onImported: () => void
}

// ─── Section colors (same as ChartOfAccountsTab) ─────────

const SECTION_COLORS: Partial<Record<string, string>> = {
  revenue: 'bg-emerald-100 text-emerald-700',
  cost_production: 'bg-red-100 text-red-700',
  cost_personnel: 'bg-orange-100 text-orange-700',
  depreciation: 'bg-amber-100 text-amber-700',
  other_costs: 'bg-gray-100 text-gray-600',
  financial: 'bg-blue-100 text-blue-700',
  assets: 'bg-sky-100 text-sky-700',
  liabilities: 'bg-pink-100 text-pink-700',
  equity: 'bg-violet-100 text-violet-700',
  extraordinary: 'bg-purple-100 text-purple-700',
}

// ─── Format euro amount ──────────────────────────────────

function fmtAmount(n: number | null): string {
  if (n == null) return '—'
  return n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// ─── Component ───────────────────────────────────────────

export default function ImportCOADialog({ companyId, existingCodes, open, onClose, onImported }: Props) {
  const [state, setState] = useState<DialogState>('idle')
  const [rows, setRows] = useState<AccountRow[]>([])
  const [error, setError] = useState('')
  const [importedCount, setImportedCount] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)

  const newCount = rows.filter(r => r.selected && !r.existing).length
  const existingCount = rows.filter(r => r.existing).length
  const selectedCount = rows.filter(r => r.selected).length

  // ─── Upload & extract ───────────────────────────────────

  const handleFile = useCallback(async (file: File) => {
    if (file.type !== 'application/pdf') {
      toast.error('Solo file PDF')
      return
    }
    if (file.size > 30 * 1024 * 1024) {
      toast.error('File troppo grande (max 30 MB)')
      return
    }

    setState('uploading')
    setError('')

    try {
      // Read file as base64
      const buffer = await file.arrayBuffer()
      const base64 = btoa(
        new Uint8Array(buffer).reduce((d, b) => d + String.fromCharCode(b), '')
      )

      // Call edge function
      const res = await fetch(`${SUPABASE_URL}/functions/v1/extract-coa-from-balance`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ pdf_base64: base64 }),
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error(errData.error || `Errore ${res.status}`)
      }

      const data = await res.json()
      const accounts: ExtractedAccount[] = data.accounts || []

      if (accounts.length === 0) {
        setError('Nessun conto trovato nel documento. Assicurati di caricare un bilancio o piano dei conti.')
        setState('error')
        return
      }

      // Map to rows with existing/selected flags
      const mapped: AccountRow[] = accounts.map(a => {
        const isExisting = existingCodes.has(a.code)
        return {
          ...a,
          existing: isExisting,
          selected: !isExisting, // new accounts selected by default
        }
      })

      setRows(mapped)
      setState('preview')
    } catch (e: any) {
      console.error('Extract error:', e)
      setError(e.message || 'Errore durante l\'estrazione')
      setState('error')
    }
  }, [existingCodes])

  // ─── Import selected accounts ───────────────────────────

  const handleImport = useCallback(async () => {
    const selected = rows.filter(r => r.selected)
    if (selected.length === 0) {
      toast.error('Seleziona almeno un conto da importare')
      return
    }

    setState('importing')

    try {
      const insertRows = selected.map((r, i) => ({
        company_id: companyId,
        code: r.code,
        name: r.name,
        section: r.section,
        parent_code: null as string | null,
        level: deriveLevel(r.code),
        is_header: r.is_header,
        active: true,
        sort_order: 0,
      }))

      // Derive parent_code: find longest existing prefix that is a header
      const allCodes = new Set([
        ...existingCodes,
        ...insertRows.map(r => r.code),
      ])
      const headerCodes = new Set([
        ...rows.filter(r => r.is_header).map(r => r.code),
      ])

      for (const row of insertRows) {
        // Try progressively shorter prefixes
        for (let len = row.code.length - 1; len >= 2; len--) {
          const prefix = row.code.slice(0, len)
          if (allCodes.has(prefix) && prefix !== row.code) {
            row.parent_code = prefix
            break
          }
        }
      }

      const { error: upsertErr } = await supabase
        .from('chart_of_accounts')
        .upsert(insertRows, { onConflict: 'company_id,code', ignoreDuplicates: true })

      if (upsertErr) throw upsertErr

      // Fire-and-forget: generate embeddings for imported accounts (backfill mode)
      triggerEntityEmbedding(companyId, ['chart_of_accounts']).catch(() => {})

      setImportedCount(selected.length)
      setState('done')
      toast.success(`Importati ${selected.length} conti nel piano dei conti`)
      onImported()
    } catch (e: any) {
      console.error('Import error:', e)
      setError(e.message || 'Errore durante l\'importazione')
      setState('error')
    }
  }, [rows, companyId, existingCodes, onImported])

  // ─── Toggle selection ───────────────────────────────────

  const toggleRow = (index: number) => {
    setRows(prev => prev.map((r, i) => i === index ? { ...r, selected: !r.selected } : r))
  }

  const selectAllNew = () => {
    setRows(prev => prev.map(r => ({ ...r, selected: !r.existing })))
  }

  const deselectAll = () => {
    setRows(prev => prev.map(r => ({ ...r, selected: false })))
  }

  // ─── Reset to idle ─────────────────────────────────────

  const resetToIdle = () => {
    setState('idle')
    setRows([])
    setError('')
  }

  // ─── Render ────────────────────────────────────────────

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-sky-600" />
            <h2 className="text-base font-semibold text-gray-900">
              Importa Piano dei Conti da Bilancio PDF
            </h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">

          {/* ─── Idle: upload area ─── */}
          {state === 'idle' && (
            <div className="space-y-4">
              <p className="text-sm text-gray-600">
                Carica il PDF del bilancio della tua azienda. L'AI analizzerà il documento
                ed estrarrà tutti i conti contabili per importarli nel piano dei conti.
              </p>
              <div
                className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center
                  hover:border-sky-400 hover:bg-sky-50/50 transition-colors cursor-pointer"
                onClick={() => fileRef.current?.click()}
              >
                <Upload className="h-8 w-8 text-gray-400 mx-auto mb-3" />
                <p className="text-sm font-medium text-gray-700">
                  Clicca per selezionare un file PDF
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  Bilancio, Piano dei Conti, o estratto contabile (max 30 MB)
                </p>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".pdf"
                className="hidden"
                onChange={e => {
                  const f = e.target.files?.[0]
                  if (f) handleFile(f)
                  e.target.value = ''
                }}
              />
            </div>
          )}

          {/* ─── Uploading: spinner ─── */}
          {state === 'uploading' && (
            <div className="flex flex-col items-center justify-center py-12 space-y-3">
              <Loader2 className="h-8 w-8 text-sky-600 animate-spin" />
              <p className="text-sm font-medium text-gray-700">Analisi del bilancio in corso...</p>
              <p className="text-xs text-gray-400">L'AI sta estraendo i conti contabili dal PDF</p>
            </div>
          )}

          {/* ─── Preview: table with checkboxes ─── */}
          {state === 'preview' && (
            <div className="space-y-3">
              {/* Summary */}
              <div className="flex items-center justify-between">
                <div className="text-sm text-gray-600">
                  <span className="font-semibold text-emerald-600">{rows.length - existingCount}</span> conti nuovi,{' '}
                  <span className="font-semibold text-gray-400">{existingCount}</span> già presenti
                </div>
                <div className="flex gap-2">
                  <button onClick={selectAllNew} className="text-xs text-sky-600 hover:text-sky-800 hover:underline">
                    Seleziona tutti nuovi
                  </button>
                  <span className="text-gray-300">|</span>
                  <button onClick={deselectAll} className="text-xs text-gray-500 hover:text-gray-700 hover:underline">
                    Deseleziona tutti
                  </button>
                </div>
              </div>

              {/* Table */}
              <div className="border border-gray-200 rounded-lg overflow-hidden max-h-[50vh] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="w-8 px-2 py-2" />
                      <th className="text-left px-2 py-2 font-medium text-gray-500">Codice</th>
                      <th className="text-left px-2 py-2 font-medium text-gray-500">Nome</th>
                      <th className="text-left px-2 py-2 font-medium text-gray-500">Sezione</th>
                      <th className="text-right px-2 py-2 font-medium text-gray-500">Importo</th>
                      <th className="text-center px-2 py-2 font-medium text-gray-500">Stato</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr
                        key={row.code}
                        className={`border-t border-gray-50 hover:bg-gray-50 ${
                          row.existing ? 'opacity-60' : ''
                        } ${row.is_header ? 'bg-gray-50/50' : ''}`}
                      >
                        <td className="px-2 py-1.5 text-center">
                          <input
                            type="checkbox"
                            checked={row.selected}
                            onChange={() => toggleRow(i)}
                            className="rounded border-gray-300"
                          />
                        </td>
                        <td className={`px-2 py-1.5 font-mono ${row.is_header ? 'font-bold' : 'font-semibold text-sky-700'}`}>
                          {row.code}
                        </td>
                        <td className={`px-2 py-1.5 ${row.is_header ? 'font-semibold' : ''}`}>
                          {row.name}
                        </td>
                        <td className="px-2 py-1.5">
                          <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap ${
                            SECTION_COLORS[row.section] || 'bg-gray-100 text-gray-600'
                          }`}>
                            {SECTION_LABELS[row.section as CoaSection] || row.section}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-gray-500">
                          {fmtAmount(row.amount)}
                        </td>
                        <td className="px-2 py-1.5 text-center">
                          {row.existing ? (
                            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">
                              Già presente
                            </span>
                          ) : (
                            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700">
                              Nuovo
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ─── Importing: spinner ─── */}
          {state === 'importing' && (
            <div className="flex flex-col items-center justify-center py-12 space-y-3">
              <Loader2 className="h-8 w-8 text-sky-600 animate-spin" />
              <p className="text-sm font-medium text-gray-700">Importazione in corso...</p>
              <p className="text-xs text-gray-400">Inserimento di {selectedCount} conti nel piano dei conti</p>
            </div>
          )}

          {/* ─── Done ─── */}
          {state === 'done' && (
            <div className="flex flex-col items-center justify-center py-12 space-y-3">
              <CheckCircle className="h-10 w-10 text-emerald-500" />
              <p className="text-sm font-medium text-gray-900">
                Importati {importedCount} conti nel piano dei conti
              </p>
              <p className="text-xs text-gray-500">
                Il tuo piano dei conti è stato aggiornato con successo.
              </p>
            </div>
          )}

          {/* ─── Error ─── */}
          {state === 'error' && (
            <div className="flex flex-col items-center justify-center py-12 space-y-3">
              <AlertTriangle className="h-10 w-10 text-amber-500" />
              <p className="text-sm font-medium text-gray-900">Errore</p>
              <p className="text-xs text-gray-500 text-center max-w-sm">{error}</p>
              <Button size="sm" variant="outline" onClick={resetToIdle}>
                Riprova
              </Button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 bg-gray-50/50 rounded-b-xl">
          <div className="text-xs text-gray-400">
            {state === 'preview' && `${selectedCount} conti selezionati`}
          </div>
          <div className="flex gap-2">
            {state === 'preview' && (
              <>
                <Button variant="outline" size="sm" onClick={resetToIdle}>
                  Indietro
                </Button>
                <Button size="sm" onClick={handleImport} disabled={selectedCount === 0}>
                  Importa {selectedCount} conti
                </Button>
              </>
            )}
            {(state === 'idle' || state === 'done' || state === 'error') && (
              <Button variant="outline" size="sm" onClick={onClose}>
                {state === 'done' ? 'Chiudi' : 'Annulla'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
