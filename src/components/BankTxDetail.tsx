// Shared bank transaction detail component — extracted from BancaPage.tsx
// Used in: BancaPage (sidebar), ScadenzarioPage (popup dialog), RiconciliazionePage (popup)

import { X, ChevronDown, Plus } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
import { fmtDate, fmtEur } from '@/lib/utils'

// ---- helpers ----

export function txTypeLabel(type?: string) {
  const map: Record<string, string> = {
    bonifico_in: 'Bonifico entrata', bonifico_out: 'Bonifico uscita',
    riba: 'RIBA', sdd: 'SDD/RID', pos: 'POS', prelievo: 'Prelievo ATM',
    commissione: 'Commissione/Spese', stipendio: 'Stipendio', f24: 'F24', altro: 'Altro',
  }
  return map[type || 'altro'] || type || 'Altro'
}

export function txTypeBadge(type?: string) {
  if (!type) return 'bg-gray-100 text-gray-600'
  if (type === 'bonifico_in' || type === 'stipendio') return 'bg-emerald-100 text-emerald-700'
  if (type === 'bonifico_out' || type === 'f24' || type === 'commissione') return 'bg-red-100 text-red-700'
  if (type === 'riba') return 'bg-blue-100 text-blue-700'
  if (type === 'sdd') return 'bg-purple-100 text-purple-700'
  if (type === 'pos') return 'bg-amber-100 text-amber-700'
  if (type === 'prelievo') return 'bg-orange-100 text-orange-700'
  return 'bg-gray-100 text-gray-600'
}

export function txDirection(tx: any): 'in' | 'out' {
  if (tx?.direction === 'in' || tx?.direction === 'out') return tx.direction
  return Number(tx?.amount || 0) >= 0 ? 'in' : 'out'
}

export function txDirectionSourceLabel(source?: string) {
  if (source === 'side_rule') return 'Regola DARE/AVERE'
  if (source === 'semantic_rule') return 'Regola semantica'
  if (source === 'manual') return 'Correzione manuale'
  return 'Fallback importo'
}

export function txDirectionConfidenceLabel(conf?: number) {
  if (conf == null || Number.isNaN(Number(conf))) return '—'
  return `${Math.round(Number(conf) * 100)}%`
}

// ---- Type dropdown with create-new ----

const TYPE_OPTIONS = [
  { value: 'bonifico_in', label: 'Bonifico entrata' },
  { value: 'bonifico_out', label: 'Bonifico uscita' },
  { value: 'riba', label: 'RIBA' },
  { value: 'sdd', label: 'SDD/RID' },
  { value: 'pos', label: 'POS' },
  { value: 'prelievo', label: 'Prelievo ATM' },
  { value: 'commissione', label: 'Commissione/Spese' },
  { value: 'stipendio', label: 'Stipendio' },
  { value: 'f24', label: 'F24' },
  { value: 'altro', label: 'Altro' },
]

function TypeDropdown({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const [customText, setCustomText] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleCustomAdd = () => {
    const trimmed = customText.trim()
    if (!trimmed) return
    onChange(trimmed)
    setCustomText('')
    setOpen(false)
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full text-left text-xs px-2 py-1.5 border rounded-md bg-white hover:bg-gray-50 flex items-center justify-between"
      >
        <span>{txTypeLabel(value) || 'Seleziona tipo'}</span>
        <ChevronDown className="h-3 w-3 text-gray-400" />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full bg-white border rounded-md shadow-lg max-h-52 overflow-y-auto">
          {TYPE_OPTIONS.map(t => (
            <button
              key={t.value}
              type="button"
              onClick={() => { onChange(t.value); setOpen(false) }}
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 transition-colors ${
                value === t.value ? 'bg-sky-50 text-sky-700 font-medium' : 'text-gray-700'
              }`}
            >
              {t.label}
            </button>
          ))}
          <div className="border-t px-2 py-1.5 flex items-center gap-1">
            <input
              value={customText}
              onChange={e => setCustomText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleCustomAdd() } }}
              placeholder="Nuovo tipo..."
              className="flex-1 text-xs px-2 py-1 border rounded focus:outline-none focus:ring-1 focus:ring-sky-400"
            />
            <button
              type="button"
              onClick={handleCustomAdd}
              className="shrink-0 p-1 rounded bg-sky-600 text-white hover:bg-sky-700"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---- component ----

export interface BankTxDetailProps {
  tx: any
  onClose: () => void
  /** If true, show edit controls */
  editable?: boolean
  /** Full edit mode */
  editMode?: boolean
  editDraft?: Record<string, any>
  editSaving?: boolean
  onEditDraftChange?: (field: string, value: any) => void
  onEditSave?: () => void
  onEnableEdit?: () => void
  onCancelEdit?: () => void
}

export default function BankTxDetail({
  tx,
  onClose,
  editable = false,
  editMode = false,
  editDraft,
  editSaving = false,
  onEditDraftChange,
  onEditSave,
  onEnableEdit,
  onCancelEdit,
}: BankTxDetailProps) {
  if (!tx) return null
  const currentDirection = txDirection(tx)
  const isIn = currentDirection === 'in'
  const rawAmount = Number(tx.amount || 0)
  const signedAmount = isIn ? Math.abs(rawAmount) : -Math.abs(rawAmount)
  const hasCommission = tx.commission_amount != null && tx.commission_amount !== 0
  const netAmount = hasCommission ? signedAmount - Number(tx.commission_amount || 0) : signedAmount

  const Row = ({ l, v, mono }: { l: string; v?: any; mono?: boolean }) => {
    if (v == null || v === '' || v === '—') return null
    return (
      <div>
        <p className="text-[10px] text-gray-400 uppercase tracking-wide">{l}</p>
        <p className={`text-xs text-gray-800 mt-0.5 break-words ${mono ? 'font-mono bg-gray-50 p-1.5 rounded text-[10px]' : ''}`}>{v}</p>
      </div>
    )
  }

  const EditField = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div>
      <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">{label}</p>
      {children}
    </div>
  )

  const inputCls = 'w-full text-xs px-2 py-1.5 border rounded-md focus:outline-none focus:ring-1 focus:ring-sky-400'

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0">
        <span className="text-sm font-semibold">Dettaglio movimento</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className={`px-4 py-4 flex-shrink-0 ${isIn ? 'bg-emerald-50' : 'bg-red-50'}`}>
        <p className={`text-2xl font-bold ${isIn ? 'text-emerald-700' : 'text-red-700'}`}>
          {isIn ? '+' : '-'}{fmtEur(Math.abs(signedAmount))}
        </p>
        {hasCommission && (
          <div className="mt-1.5 space-y-0.5">
            <p className="text-xs text-orange-600">Commissione: {fmtEur(tx.commission_amount)}</p>
            <p className="text-xs font-semibold text-gray-700">Importo netto: {fmtEur(netAmount)}</p>
          </div>
        )}
        <div className="flex items-center gap-2 mt-2">
          <span className="text-xs text-gray-500">{fmtDate(tx.date)}</span>
          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${txTypeBadge(tx.transaction_type)}`}>
            {txTypeLabel(tx.transaction_type)}
          </span>
          {tx.direction_needs_review && (
            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
              Da verificare
            </span>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        <Row l="Direzione" v={currentDirection === 'in' ? 'Entrata' : 'Uscita'} />
        <Row l="Origine decisione" v={txDirectionSourceLabel(tx.direction_source)} />
        <Row l="Confidenza" v={txDirectionConfidenceLabel(tx.direction_confidence)} />
        <Row l="Motivo" v={tx.direction_reason} />
        <Row l="Data accredito" v={tx.date ? fmtDate(tx.date) : null} />
        <Row l="Data valuta" v={tx.value_date ? fmtDate(tx.value_date) : null} />
        <Row l="Controparte" v={tx.counterparty_name} />
        <Row l="Origine controparte" v={tx.counterparty_source} />
        <Row l="Confidenza controparte" v={tx.counterparty_confidence != null ? `${Math.round(Number(tx.counterparty_confidence) * 100)}%` : null} />
        <Row l="Controparte da verificare" v={tx.counterparty_needs_review ? 'Si' : null} />
        <Row l="IBAN / Conto controparte" v={tx.counterparty_account} />
        <Row l="Saldo dopo" v={tx.balance != null ? fmtEur(tx.balance) : null} />
        <Row l="Descrizione breve" v={tx.description} />
        <Row l="Origine descrizione" v={tx.description_source} />
        <Row l="Confidenza descrizione" v={tx.description_confidence != null ? `${Math.round(Number(tx.description_confidence) * 100)}%` : null} />
        {tx.raw_text && (
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">Testo operazione completo</p>
            <pre className="mt-0.5 text-[10px] text-gray-800 bg-gray-50 p-2 rounded whitespace-pre-wrap font-mono">
              {tx.raw_text}
            </pre>
          </div>
        )}
        <Row l="Rif. fattura" v={tx.invoice_ref} />
        <Row l="ID flusso CBI" v={tx.cbi_flow_id} />
        <Row l="Filiale disponente" v={tx.branch} />
        <Row l="Riferimento" v={tx.reference} />
        <Row l="Stato riconciliazione" v={tx.reconciliation_status} />

        {/* Triage + Classification section */}
        {tx.tx_nature && (
          <div className="border-t pt-3 mt-3">
            <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-2">Analisi AI</p>
            <div className="flex items-center gap-2 mb-2">
              {tx.tx_nature === 'invoice_payment' && (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-sky-100 text-sky-700">Pagamento fattura</span>
              )}
              {tx.tx_nature === 'no_invoice' && (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-violet-100 text-violet-700">Senza fattura</span>
              )}
              {tx.tx_nature === 'giro_conto' && (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-gray-200 text-gray-600">Giroconto</span>
              )}
            </div>
            {tx.tx_nature === 'no_invoice' && tx.classification_status !== 'pending' && (
              <div className="space-y-1.5 bg-violet-50 rounded-lg p-2.5">
                {tx.classification_reasoning && (
                  <p className="text-[10px] text-violet-700">{tx.classification_reasoning}</p>
                )}
                {tx.classification_confidence != null && (
                  <p className="text-[10px] text-gray-500">Confidenza: {Math.round(tx.classification_confidence)}%</p>
                )}
                {tx.fiscal_flags?.is_tax_payment && (
                  <div className="flex items-center gap-1 px-2 py-1 bg-amber-50 border border-amber-200 rounded text-[10px] text-amber-800">
                    Pagamento tributo: {tx.fiscal_flags.tax_type || 'N/D'}
                  </div>
                )}
                <p className="text-[10px] text-gray-500">
                  Stato: {tx.classification_status === 'ai_suggested' ? 'Suggerito AI' : tx.classification_status === 'confirmed' ? 'Confermato' : tx.classification_status}
                  {tx.classification_source && ` (${tx.classification_source})`}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
      {editable && (
        <div className="border-t px-4 py-3 bg-gray-50 max-h-[50vh] overflow-y-auto">
          {!editMode ? (
            <button
              onClick={onEnableEdit}
              className="w-full text-xs px-3 py-1.5 rounded border border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
            >
              Modifica
            </button>
          ) : (
            <div className="space-y-3">
              <p className="text-xs font-semibold text-gray-700">Modifica movimento</p>

              {/* Direction */}
              <EditField label="Direzione">
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => onEditDraftChange?.('direction', 'in')}
                    className={`text-xs px-2 py-1.5 rounded border font-medium ${
                      editDraft?.direction === 'in'
                        ? 'bg-emerald-600 border-emerald-600 text-white'
                        : 'bg-white border-gray-200 text-gray-700'
                    }`}
                  >
                    Entrata
                  </button>
                  <button
                    type="button"
                    onClick={() => onEditDraftChange?.('direction', 'out')}
                    className={`text-xs px-2 py-1.5 rounded border font-medium ${
                      editDraft?.direction === 'out'
                        ? 'bg-red-600 border-red-600 text-white'
                        : 'bg-white border-gray-200 text-gray-700'
                    }`}
                  >
                    Uscita
                  </button>
                </div>
              </EditField>

              {/* Counterparty */}
              <EditField label="Controparte">
                <input
                  className={inputCls}
                  value={editDraft?.counterparty_name || ''}
                  onChange={e => onEditDraftChange?.('counterparty_name', e.target.value)}
                />
              </EditField>

              {/* Description */}
              <EditField label="Descrizione">
                <input
                  className={inputCls}
                  value={editDraft?.description || ''}
                  onChange={e => onEditDraftChange?.('description', e.target.value)}
                />
              </EditField>

              {/* Dates */}
              <div className="grid grid-cols-2 gap-2">
                <EditField label="Data">
                  <input
                    type="date"
                    className={inputCls}
                    value={editDraft?.date || ''}
                    onChange={e => onEditDraftChange?.('date', e.target.value)}
                  />
                </EditField>
                <EditField label="Data valuta">
                  <input
                    type="date"
                    className={inputCls}
                    value={editDraft?.value_date || ''}
                    onChange={e => onEditDraftChange?.('value_date', e.target.value)}
                  />
                </EditField>
              </div>

              {/* Transaction type */}
              <EditField label="Tipo operazione">
                <TypeDropdown
                  value={editDraft?.transaction_type || ''}
                  onChange={v => onEditDraftChange?.('transaction_type', v)}
                />
              </EditField>

              {/* Invoice ref */}
              <EditField label="Rif. fattura">
                <input
                  className={inputCls}
                  value={editDraft?.invoice_ref || ''}
                  onChange={e => onEditDraftChange?.('invoice_ref', e.target.value)}
                />
              </EditField>

              {/* Reference */}
              <EditField label="Riferimento">
                <input
                  className={inputCls}
                  value={editDraft?.reference || ''}
                  onChange={e => onEditDraftChange?.('reference', e.target.value)}
                />
              </EditField>

              {/* Actions */}
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={onEditSave}
                  disabled={editSaving}
                  className="flex-1 text-xs px-3 py-1.5 rounded bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50"
                >
                  {editSaving ? 'Salvataggio...' : 'Salva'}
                </button>
                <button
                  type="button"
                  onClick={onCancelEdit}
                  className="flex-1 text-xs px-3 py-1.5 rounded border border-gray-200 text-gray-700 hover:bg-gray-50"
                >
                  Annulla
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
