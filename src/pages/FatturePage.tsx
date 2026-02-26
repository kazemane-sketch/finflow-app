import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { processInvoiceFile, TIPO, MP, REG, type ParseResult, type ParsedInvoice, reparseXml } from '@/lib/invoiceParser'
import { saveInvoicesToDB, loadInvoices, loadInvoiceDetail, type DBInvoice, type DBInvoiceDetail } from '@/lib/invoiceSaver'
import { useCompany } from '@/hooks/useCompany'
import { fmtNum, fmtEur, fmtDate } from '@/lib/utils'
import {
  Upload, FileText, Search, ChevronDown, ChevronRight,
  CheckCircle2, Clock, AlertTriangle, CreditCard,
  Database, FileCode, Package, Loader2, Copy, X,
  AlertCircle, CheckCircle, XCircle, FileWarning,
} from 'lucide-react'
import { toast } from 'sonner'

const NAT: Record<string, string> = { N1: "Escl. art.15", N2: "Non soggette", "N2.1": "Non sogg. art.7", "N2.2": "Non sogg. altri", N3: "Non imponibili", "N3.1": "Esportaz.", "N3.2": "Cess. intra.", "N3.3": "S.Marino", "N3.4": "Op. assimilate", "N3.5": "Dich. intento", "N3.6": "Altre", N4: "Esenti", N5: "Margine", N6: "Reverse charge", "N6.1": "Rottami", "N6.2": "Oro", "N6.3": "Subapp. edil.", "N6.4": "Fabbricati", "N6.5": "Cellulari", "N6.6": "Elettronici", "N6.7": "Edile", "N6.8": "Energia", "N6.9": "RC altri", N7: "IVA in altro UE" }
const ESI: Record<string, string> = { I: "Immediata", D: "Differita", S: "Split payment" }
const CP: Record<string, string> = { TP01: "A rate", TP02: "Completo", TP03: "Anticipo" }
const RIT: Record<string, string> = { RT01: "Pers. fisiche", RT02: "Pers. giuridiche", RT03: "INPS", RT04: "ENASARCO", RT05: "ENPAM" }

const STATUS_MAP: Record<string, { label: string; color: string; icon: any }> = {
  pending: { label: 'Da pagare', color: 'text-amber-600 bg-amber-50', icon: Clock },
  paid: { label: 'Pagata', color: 'text-emerald-600 bg-emerald-50', icon: CheckCircle2 },
  overdue: { label: 'Scaduta', color: 'text-red-600 bg-red-50', icon: AlertTriangle },
  partial: { label: 'Parziale', color: 'text-blue-600 bg-blue-50', icon: CreditCard },
}

interface ImportLogEntry {
  fn: string
  status: 'ok' | 'duplicate' | 'parse_error' | 'save_error'
  error?: string
  rawXml?: string
}

// ============================================================
// MAIN PAGE
// ============================================================
export default function FatturePage() {
  const { company, ensureCompany } = useCompany()
  const [invoices, setInvoices] = useState<DBInvoice[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<DBInvoiceDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const ref = useRef<HTMLInputElement>(null)

  // Import progress & log
  const [progress, setProgress] = useState<{ current: number; total: number; phase: string } | null>(null)
  const [importLog, setImportLog] = useState<ImportLogEntry[]>([])
  const [showLog, setShowLog] = useState(false)

  const fetchInvoices = useCallback(async () => {
    if (!company) { setLoading(false); return }
    try {
      const data = await loadInvoices(company.id)
      setInvoices(data)
    } catch (e: any) { console.error('Errore caricamento fatture:', e) }
    setLoading(false)
  }, [company])

  useEffect(() => { fetchInvoices() }, [fetchInvoices])

  useEffect(() => {
    if (!selectedId) { setDetail(null); return }
    setDetailLoading(true)
    loadInvoiceDetail(selectedId).then(d => { setDetail(d); setDetailLoading(false) })
  }, [selectedId])

  // ============================================================
  // IMPORT WITH PROGRESS
  // ============================================================
  const handleFiles = useCallback(async (files: FileList | File[]) => {
    setImporting(true)
    setShowLog(true)
    setSelectedId(null)
    const log: ImportLogEntry[] = []
    const allResults: ParseResult[] = []
    const fileArr = Array.from(files)

    // Phase 1: Parse files
    let totalParsed = 0
    for (const f of fileArr) {
      setProgress({ current: totalParsed, total: 0, phase: `Lettura ${f.name}...` })
      try {
        const results = await processInvoiceFile(f)
        allResults.push(...results)
        // Log parse errors immediately
        for (const r of results) {
          if (r.err) {
            log.push({ fn: r.fn, status: 'parse_error', error: r.err, rawXml: r.rawXml || undefined })
          }
        }
        totalParsed += results.length
      } catch (e: any) {
        log.push({ fn: f.name, status: 'parse_error', error: e.message })
        totalParsed++
      }
      setImportLog([...log])
    }

    const okResults = allResults.filter(r => !r.err && r.data)
    const totalToSave = okResults.length

    if (totalToSave === 0) {
      setProgress(null)
      setImporting(false)
      setImportLog([...log])
      toast.error(`Nessuna fattura valida su ${allResults.length} file letti.`)
      return
    }

    // Phase 2: Save to DB one by one with progress
    try {
      const companyId = await ensureCompany(okResults[0].data.ces)

      for (let i = 0; i < okResults.length; i++) {
        const r = okResults[i]
        setProgress({ current: i + 1, total: totalToSave, phase: `Salvando ${i + 1}/${totalToSave}` })

        try {
          const saveResults = await saveInvoicesToDB([r], companyId)
          const sr = saveResults[0]
          if (sr.success) {
            if (sr.error?.includes('Duplicato')) {
              log.push({ fn: r.fn, status: 'duplicate', error: 'Fattura già importata' })
            } else {
              log.push({ fn: r.fn, status: 'ok' })
            }
          } else {
            log.push({ fn: r.fn, status: 'save_error', error: sr.error, rawXml: r.rawXml })
          }
        } catch (e: any) {
          log.push({ fn: r.fn, status: 'save_error', error: e.message, rawXml: r.rawXml })
        }

        setImportLog([...log])
      }
    } catch (e: any) {
      toast.error('Errore: ' + e.message)
    }

    // Done
    setProgress(null)
    setImporting(false)
    setImportLog([...log])

    const saved = log.filter(l => l.status === 'ok').length
    const dupes = log.filter(l => l.status === 'duplicate').length
    const errors = log.filter(l => l.status === 'parse_error' || l.status === 'save_error').length

    if (saved > 0) toast.success(`${saved} fatture importate${dupes ? `, ${dupes} duplicati` : ''}${errors ? `, ${errors} errori` : ''}`)
    else if (dupes > 0) toast.info(`${dupes} fatture già presenti${errors ? `, ${errors} errori` : ''}`)
    else toast.error(`${errors} errori, nessuna fattura importata`)

    await fetchInvoices()
  }, [ensureCompany, fetchInvoices])

  const filtered = invoices.filter(inv => {
    if (statusFilter !== 'all' && inv.payment_status !== statusFilter) return false
    if (!search) return true
    const s = search.toLowerCase()
    return inv.counterparty?.name?.toLowerCase().includes(s) || inv.number?.toLowerCase().includes(s) || inv.source_filename?.toLowerCase().includes(s)
  })

  const stats = {
    total: invoices.length,
    pending: invoices.filter(i => i.payment_status === 'pending').length,
    overdue: invoices.filter(i => i.payment_status === 'overdue').length,
    paid: invoices.filter(i => i.payment_status === 'paid').length,
    totalAmount: invoices.reduce((s, i) => s + (i.doc_type === 'TD04' ? -1 : 1) * i.total_amount, 0),
  }

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-80 border-r flex flex-col shrink-0 bg-card">
        <div className="px-4 py-3 border-b space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold">Fatture</h2>
            <span className="text-xs font-bold text-emerald-700">{fmtEur(stats.totalAmount)}</span>
          </div>
          {invoices.length > 0 && (
            <div className="flex gap-1">
              {[
                { key: 'all', label: `Tutte ${stats.total}` },
                { key: 'pending', label: `⏳ ${stats.pending}` },
                { key: 'overdue', label: `⚠ ${stats.overdue}` },
                { key: 'paid', label: `✓ ${stats.paid}` },
              ].map(f => (
                <button key={f.key} onClick={() => setStatusFilter(f.key)}
                  className={`flex-1 text-[10px] font-semibold py-1 rounded transition-all ${
                    statusFilter === f.key ? 'ring-1 ring-primary bg-primary/10 text-primary' : 'bg-gray-50 text-gray-400 hover:bg-gray-100'
                  }`}>{f.label}</button>
              ))}
            </div>
          )}
          <div className="relative">
            <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cerca fornitore, numero..." className="pl-8 h-8 text-xs" />
          </div>

          {/* Import button with progress */}
          {progress ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-xs">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                <span className="font-medium text-primary">{progress.phase}</span>
              </div>
              {progress.total > 0 && (
                <div className="w-full bg-gray-100 rounded-full h-1.5">
                  <div className="bg-primary h-1.5 rounded-full transition-all" style={{ width: `${(progress.current / progress.total) * 100}%` }} />
                </div>
              )}
            </div>
          ) : (
            <Button variant="outline" size="sm" className="w-full text-xs gap-1.5" onClick={() => ref.current?.click()} disabled={importing}>
              <Upload className="h-3.5 w-3.5" /> Importa fatture XML/P7M
            </Button>
          )}

          {/* Show log button */}
          {importLog.length > 0 && !importing && (
            <button onClick={() => { setShowLog(true); setSelectedId(null) }}
              className="w-full text-[11px] text-left px-2 py-1.5 rounded bg-gray-50 hover:bg-gray-100 transition-colors">
              📋 Log ultima importazione
              <span className="float-right text-muted-foreground">
                {importLog.filter(l => l.status === 'ok').length}✓
                {importLog.filter(l => l.status === 'duplicate').length > 0 && ` ${importLog.filter(l => l.status === 'duplicate').length}⇌`}
                {importLog.filter(l => l.status === 'parse_error' || l.status === 'save_error').length > 0 && ` ${importLog.filter(l => l.status === 'parse_error' || l.status === 'save_error').length}✕`}
              </span>
            </button>
          )}

          <input ref={ref} type="file" multiple accept=".xml,.p7m,.zip" onChange={e => { if (e.target.files) handleFiles(e.target.files); e.target.value = '' }} className="hidden" />
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 px-4">
              <FileText className="h-10 w-10 mx-auto mb-3 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">{invoices.length === 0 ? 'Nessuna fattura importata' : 'Nessun risultato'}</p>
            </div>
          ) : (
            filtered.map(inv => <InvoiceCard key={inv.id} inv={inv} selected={selectedId === inv.id} onClick={() => { setSelectedId(inv.id); setShowLog(false) }} />)
          )}
        </div>
      </div>

      {/* Detail panel */}
      <div className="flex-1 overflow-y-auto bg-background">
        {showLog ? (
          <ImportLogPanel log={importLog} importing={importing} progress={progress} onClose={() => setShowLog(false)} />
        ) : detailLoading ? (
          <div className="flex items-center justify-center h-full"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : detail ? (
          <FullInvoiceDetail inv={detail} onClose={() => setSelectedId(null)} />
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center max-w-md px-8">
              <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-50 to-indigo-50 mb-6">
                <FileText className="h-10 w-10 text-blue-400" />
              </div>
              <h3 className="text-lg font-semibold mb-2">Fatture Elettroniche</h3>
              <p className="text-sm text-muted-foreground mb-6">Importa file XML, P7M o ZIP per visualizzare e gestire le tue fatture.</p>
              <Button onClick={() => ref.current?.click()} disabled={importing} className="gap-2">
                <Upload className="h-4 w-4" /> Importa fatture
              </Button>
              <div className="flex items-center justify-center gap-6 mt-6 text-xs text-muted-foreground">
                <span className="flex items-center gap-1"><FileCode className="h-3.5 w-3.5" /> XML</span>
                <span className="flex items-center gap-1"><Package className="h-3.5 w-3.5" /> P7M</span>
                <span className="flex items-center gap-1"><Database className="h-3.5 w-3.5" /> ZIP</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================
// IMPORT LOG PANEL
// ============================================================
function ImportLogPanel({ log, importing, progress, onClose }: {
  log: ImportLogEntry[]; importing: boolean; progress: { current: number; total: number; phase: string } | null; onClose: () => void
}) {
  const [expandedError, setExpandedError] = useState<number | null>(null)
  const okCount = log.filter(l => l.status === 'ok').length
  const dupeCount = log.filter(l => l.status === 'duplicate').length
  const errCount = log.filter(l => l.status === 'parse_error' || l.status === 'save_error').length

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold">Log Importazione</h2>
        <Button variant="ghost" size="sm" onClick={onClose} className="text-xs">✕ Chiudi</Button>
      </div>

      {/* Progress bar during import */}
      {importing && progress && (
        <div className="mb-4 p-3 rounded-lg bg-primary/5 border border-primary/20">
          <div className="flex items-center gap-2 mb-2">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span className="text-sm font-medium text-primary">{progress.phase}</span>
          </div>
          {progress.total > 0 && (
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div className="bg-primary h-2 rounded-full transition-all duration-300" style={{ width: `${(progress.current / progress.total) * 100}%` }} />
            </div>
          )}
        </div>
      )}

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-center">
          <div className="text-2xl font-bold text-emerald-700">{okCount}</div>
          <div className="text-[11px] text-emerald-600 font-medium">Importate</div>
        </div>
        <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-center">
          <div className="text-2xl font-bold text-amber-700">{dupeCount}</div>
          <div className="text-[11px] text-amber-600 font-medium">Duplicati</div>
        </div>
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-center">
          <div className="text-2xl font-bold text-red-700">{errCount}</div>
          <div className="text-[11px] text-red-600 font-medium">Errori</div>
        </div>
      </div>

      {/* Log entries */}
      <div className="rounded-lg border overflow-hidden">
        <div className="max-h-[60vh] overflow-y-auto">
          {log.map((entry, i) => (
            <div key={i} className={`border-b last:border-0 ${entry.status === 'ok' ? '' : entry.status === 'duplicate' ? 'bg-amber-50/50' : 'bg-red-50/50'}`}>
              <div className="flex items-center gap-2 px-3 py-2">
                {entry.status === 'ok' && <CheckCircle className="h-4 w-4 text-emerald-500 shrink-0" />}
                {entry.status === 'duplicate' && <AlertCircle className="h-4 w-4 text-amber-500 shrink-0" />}
                {(entry.status === 'parse_error' || entry.status === 'save_error') && <XCircle className="h-4 w-4 text-red-500 shrink-0" />}
                <span className="text-xs font-mono truncate flex-1">{entry.fn}</span>
                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                  entry.status === 'ok' ? 'bg-emerald-100 text-emerald-700' :
                  entry.status === 'duplicate' ? 'bg-amber-100 text-amber-700' :
                  'bg-red-100 text-red-700'
                }`}>
                  {entry.status === 'ok' ? 'OK' : entry.status === 'duplicate' ? 'DUPLICATO' : entry.status === 'parse_error' ? 'ERRORE PARSING' : 'ERRORE SALVATAGGIO'}
                </span>
                {(entry.error || entry.rawXml) && (
                  <button onClick={() => setExpandedError(expandedError === i ? null : i)} className="text-[10px] text-muted-foreground hover:text-foreground">
                    {expandedError === i ? '▲' : '▼'}
                  </button>
                )}
              </div>
              {expandedError === i && (
                <div className="px-3 pb-2 space-y-1.5">
                  {entry.error && (
                    <div className="text-[11px] text-red-600 bg-red-50 p-2 rounded font-mono whitespace-pre-wrap break-all">{entry.error}</div>
                  )}
                  {entry.rawXml && (
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] text-muted-foreground">XML sorgente ({Math.round(entry.rawXml.length / 1024)} KB)</span>
                        <button onClick={() => navigator.clipboard?.writeText(entry.rawXml!)} className="text-[10px] text-primary hover:underline">📋 Copia XML</button>
                      </div>
                      <pre className="text-[10px] bg-gray-900 text-gray-300 p-2 rounded max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono">{entry.rawXml.substring(0, 2000)}{entry.rawXml.length > 2000 ? '\n... (troncato)' : ''}</pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {!importing && log.length > 0 && (
        <p className="text-[11px] text-muted-foreground text-center mt-3">
          Totale: {log.length} file elaborati
        </p>
      )}
    </div>
  )
}

// ============================================================
// SIDEBAR CARD
// ============================================================
function InvoiceCard({ inv, selected, onClick }: { inv: DBInvoice; selected: boolean; onClick: () => void }) {
  const nc = inv.doc_type === 'TD04' || inv.doc_type === 'TD05'
  const status = STATUS_MAP[inv.payment_status] || STATUS_MAP.pending
  const StatusIcon = status.icon
  return (
    <div onClick={onClick} className={`px-4 py-3 border-b cursor-pointer transition-all ${selected ? 'bg-primary/5 border-l-2 border-l-primary' : 'hover:bg-accent/50'}`}>
      <div className="flex justify-between items-start gap-2">
        <span className="text-sm font-semibold truncate flex-1">{inv.counterparty?.name || '—'}</span>
        <span className={`text-sm font-bold shrink-0 ${nc ? 'text-red-600' : 'text-emerald-700'}`}>{nc ? '-' : ''}{fmtEur(inv.total_amount)}</span>
      </div>
      <div className="flex justify-between items-center mt-1.5">
        <span className="text-[11px] text-muted-foreground">n.{inv.number} — {fmtDate(inv.date)}</span>
        <span className={`inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded ${status.color}`}>
          <StatusIcon className="h-3 w-3" />{status.label}
        </span>
      </div>
      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded mt-1 inline-block ${nc ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'}`}>{TIPO[inv.doc_type] || inv.doc_type}</span>
    </div>
  )
}

// ============================================================
// FULL DETAIL VIEW (re-parses raw_xml like fattura-v3)
// ============================================================
function FullInvoiceDetail({ inv, onClose }: { inv: DBInvoiceDetail; onClose: () => void }) {
  const [showXml, setShowXml] = useState(false)
  const parsed = useMemo<ParsedInvoice | null>(() => {
    if (!inv.raw_xml) return null
    try { return reparseXml(inv.raw_xml) } catch { return null }
  }, [inv.raw_xml])

  const d = parsed
  const b = d?.bodies?.[0]
  const nc = b?.tipo === 'TD04' || b?.tipo === 'TD05'
  const hasContratti = (b?.contratti?.length ?? 0) > 0 || (b?.ordini?.length ?? 0) > 0
  const status = STATUS_MAP[inv.payment_status] || STATUS_MAP.pending
  const StatusIcon = status.icon

  if (!d || !b) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <Button variant="ghost" size="sm" onClick={onClose} className="text-xs mb-4">← Lista</Button>
        <div className="text-center py-8 text-muted-foreground">XML originale non disponibile.</div>
      </div>
    )
  }

  const xmlDataUrl = inv.raw_xml ? "data:text/xml;charset=utf-8," + encodeURIComponent(inv.raw_xml) : null
  const xmlFileName = (inv.source_filename || 'fattura').replace(/\.p7m$/i, '').replace(/\.xml$/i, '') + '.xml'

  return (
    <div className="p-5 overflow-y-auto">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <Button variant="ghost" size="sm" onClick={onClose} className="text-xs gap-1">← Lista</Button>
          <div className="flex gap-2">
            <Button variant={showXml ? 'default' : 'outline'} size="sm" className="text-xs gap-1" onClick={() => setShowXml(!showXml)}>
              <FileCode className="h-3.5 w-3.5" />{showXml ? '✕ Chiudi XML' : '〈/〉 Vedi XML'}
            </Button>
            {xmlDataUrl && (
              <a href={xmlDataUrl} download={xmlFileName} className="inline-flex items-center gap-1 border rounded-md px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors">⬇ Scarica XML</a>
            )}
          </div>
        </div>

        {showXml && inv.raw_xml && (
          <div className="mb-4 rounded-lg overflow-hidden border" style={{ background: '#1a1d24' }}>
            <div className="flex items-center justify-between px-3 py-2" style={{ background: '#252830' }}>
              <span className="text-xs font-medium" style={{ color: '#7eb8e0' }}>XML Sorgente — {Math.round(inv.raw_xml.length / 1024)} KB</span>
              <button onClick={() => navigator.clipboard?.writeText(inv.raw_xml!)} className="text-[11px] px-2 py-1 rounded" style={{ background: '#3a3f4c', color: '#ccc' }}>📋 Copia</button>
            </div>
            <pre className="p-3 text-[11px] overflow-auto max-h-96 whitespace-pre-wrap break-all leading-relaxed" style={{ color: '#c8ccd8', fontFamily: "'JetBrains Mono', monospace" }}>{inv.raw_xml}</pre>
          </div>
        )}

        {/* Header */}
        <div className="text-center mb-5 pb-4 border-b-2 border-blue-100">
          <div className="flex items-center justify-center gap-2 mb-2">
            <span className={`text-[11px] font-semibold px-2 py-1 rounded ${nc ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'}`}>{TIPO[b.tipo] || b.tipo}</span>
            <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded ${status.color}`}><StatusIcon className="h-3 w-3" />{status.label}</span>
          </div>
          <h2 className="text-[22px] font-extrabold">{TIPO[b.tipo] || b.tipo} &nbsp; N. {b.numero}</h2>
          <div className="flex items-center justify-center gap-5 mt-2 text-sm">
            <span><span className="text-muted-foreground text-xs">Data: </span><strong>{fmtDate(b.data)}</strong></span>
            <span className="px-2 py-0.5 rounded bg-primary/10 text-primary text-[11px] font-semibold">{d.ver}</span>
            <span className="px-2 py-0.5 rounded bg-purple-50 text-purple-700 text-[11px] font-semibold">{inv.parse_method}</span>
          </div>
        </div>

        {/* Da / Per */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <Sec title="Da:">
            <Row l="Denominazione" v={d.ced.denom} accent />
            <Row l="Partita IVA" v={d.ced.piva} />
            <Row l="Codice Fiscale" v={d.ced.cf} />
            <Row l="Regime Fiscale" v={d.ced.regime ? `${d.ced.regime} (${REG[d.ced.regime] || ''})` : ''} />
            <Row l="Sede" v={d.ced.sede} />
            <Row l="Iscrizione REA" v={d.ced.reaNumero ? `${d.ced.reaUfficio} ${d.ced.reaNumero}` : ''} />
            <Row l="Capitale Sociale" v={d.ced.capitale ? fmtEur(d.ced.capitale) : ''} />
            <Row l="In Liquidazione" v={d.ced.liquidazione === 'LN' ? 'LN (No)' : d.ced.liquidazione === 'LS' ? 'LS (Sì)' : d.ced.liquidazione} />
            <Row l="Telefono" v={d.ced.tel} />
            <Row l="Email" v={d.ced.email} />
          </Sec>
          <Sec title="Per:">
            <Row l="Denominazione" v={d.ces.denom} accent />
            <Row l="Partita IVA" v={d.ces.piva} />
            <Row l="Codice Fiscale" v={d.ces.cf} />
            <Row l="Sede" v={d.ces.sede} />
          </Sec>
        </div>

        {hasContratti && (
          <Sec title="Riferimenti">
            {b.contratti.map((c, i) => <Row key={`c${i}`} l="Rif. Contratto" v={[c.id, c.data ? fmtDate(c.data) : '', c.cig ? `CIG:${c.cig}` : '', c.cup ? `CUP:${c.cup}` : ''].filter(Boolean).join(' — ')} />)}
            {b.ordini.map((o, i) => <Row key={`o${i}`} l="Rif. Ordine" v={[o.id, o.data ? fmtDate(o.data) : '', o.cig ? `CIG:${o.cig}` : '', o.cup ? `CUP:${o.cup}` : ''].filter(Boolean).join(' — ')} />)}
          </Sec>
        )}

        {b.causali?.length > 0 && (
          <Sec title="Causale (Note)">
            {b.causali.map((c, i) => <p key={i} className="text-xs py-0.5">{c}</p>)}
          </Sec>
        )}

        {/* Beni e Servizi */}
        <Sec title="Dettaglio Beni e Servizi">
          <div className="overflow-x-auto -mx-4">
            <table className="w-full text-[12px] min-w-[650px]">
              <thead>
                <tr className="border-b-2 border-primary/20 bg-primary/5">
                  {b.linee?.some(l => l.codiceArticolo) && <th className="text-left px-3 py-2 font-semibold text-primary text-[11px]">Codice Articolo</th>}
                  <th className="text-left px-3 py-2 font-semibold text-primary text-[11px]">Descrizione</th>
                  <th className="text-right px-3 py-2 font-semibold text-primary text-[11px]">Quantità</th>
                  <th className="text-right px-3 py-2 font-semibold text-primary text-[11px]">Prezzo Unitario</th>
                  <th className="text-right px-3 py-2 font-semibold text-primary text-[11px]">Aliquota IVA</th>
                  <th className="text-right px-3 py-2 font-semibold text-primary text-[11px]">Prezzo Totale</th>
                </tr>
              </thead>
              <tbody>
                {b.linee?.map((l, i) => (
                  <tr key={i} className="border-b border-border/40 hover:bg-accent/20">
                    {b.linee?.some(x => x.codiceArticolo) && <td className="px-3 py-1.5 text-left text-muted-foreground">{l.codiceArticolo || '—'}</td>}
                    <td className="px-3 py-1.5 text-left">{l.descrizione}</td>
                    <td className="px-3 py-1.5 text-right">{l.quantita ? fmtNum(l.quantita) : '1'}</td>
                    <td className="px-3 py-1.5 text-right">{fmtNum(l.prezzoUnitario)}</td>
                    <td className="px-3 py-1.5 text-right">{fmtNum(l.aliquotaIVA)}%</td>
                    <td className="px-3 py-1.5 text-right font-semibold">{fmtNum(l.prezzoTotale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Sec>

        {/* Riepilogo IVA */}
        <Sec title="Riepilogo IVA e Totali">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b-2 border-primary/20 bg-primary/5">
                <th className="text-left px-3 py-2 font-semibold text-primary text-[11px]">Esigibilità IVA</th>
                <th className="text-left px-3 py-2 font-semibold text-primary text-[11px]">Aliquota IVA</th>
                <th className="text-right px-3 py-2 font-semibold text-primary text-[11px]">Imposta</th>
                <th className="text-right px-3 py-2 font-semibold text-primary text-[11px]">Imponibile</th>
              </tr>
            </thead>
            <tbody>
              {b.riepilogo?.map((r, i) => (
                <tr key={i} className="border-b border-border/40">
                  <td className="px-3 py-1.5 text-left">{r.esigibilita ? `${ESI[r.esigibilita] || r.esigibilita}` : ''}</td>
                  <td className="px-3 py-1.5 text-left">{fmtNum(r.aliquota)}%{r.natura ? ` - ${r.natura} (${NAT[r.natura] || ''})` : ''}{r.rifNorm ? ` - ${r.rifNorm}` : ''}</td>
                  <td className="px-3 py-1.5 text-right font-semibold">{fmtNum(r.imposta)}</td>
                  <td className="px-3 py-1.5 text-right font-semibold">{fmtNum(r.imponibile)}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-primary/20">
                <td className="px-3 py-1.5 text-left font-bold" colSpan={2}>Totale</td>
                <td className="px-3 py-1.5 text-right font-bold text-primary">{fmtNum(b.riepilogo?.reduce((s, r) => s + parseFloat(r.imposta || '0'), 0))}</td>
                <td className="px-3 py-1.5 text-right font-bold text-primary">{fmtNum(b.riepilogo?.reduce((s, r) => s + parseFloat(r.imponibile || '0'), 0))}</td>
              </tr>
            </tbody>
          </table>
          <div className="mt-3 grid grid-cols-4 gap-2 bg-primary/5 p-3 rounded-lg">
            <div><div className="text-[10px] text-primary font-bold">Importo Bollo</div><div className="text-xs font-semibold">{b.bollo?.importo ? fmtEur(b.bollo.importo) : ''}</div></div>
            <div><div className="text-[10px] text-primary font-bold">Sconto o Rincaro</div><div className="text-xs font-semibold">{b.arrotondamento || ''}</div></div>
            <div><div className="text-[10px] text-primary font-bold">Divisa</div><div className="text-xs font-semibold">{b.divisa}</div></div>
            <div className="text-right"><div className="text-[10px] text-primary font-bold">Totale Documento</div><div className={`text-xl font-extrabold ${nc ? 'text-red-600' : 'text-emerald-700'}`}>{fmtEur(b.totale)}</div></div>
          </div>
        </Sec>

        {/* Pagamento */}
        <Sec title="Modalità Pagamento">
          <table className="w-full text-[12px]">
            <thead><tr className="border-b-2 border-primary/20 bg-primary/5">
              <th className="text-left px-3 py-2 font-semibold text-primary text-[11px]">Modalità</th>
              <th className="text-left px-3 py-2 font-semibold text-primary text-[11px]">IBAN</th>
              <th className="text-right px-3 py-2 font-semibold text-primary text-[11px]">Scadenza</th>
              <th className="text-right px-3 py-2 font-semibold text-primary text-[11px]">Importo</th>
            </tr></thead>
            <tbody>
              {b.pagamenti?.length > 0 ? b.pagamenti.map((p, i) => (
                <tr key={i} className="border-b border-border/40">
                  <td className="px-3 py-1.5 text-left">{p.modalita ? `${p.modalita} (${MP[p.modalita] || ''})` : ''}{b.condPag ? ` - ${b.condPag} (${CP[b.condPag] || ''})` : ''}</td>
                  <td className="px-3 py-1.5 text-left">{p.iban || ''}</td>
                  <td className="px-3 py-1.5 text-right">{fmtDate(p.scadenza)}</td>
                  <td className="px-3 py-1.5 text-right font-bold">{fmtEur(p.importo)}</td>
                </tr>
              )) : <tr><td className="px-3 py-1.5 text-muted-foreground" colSpan={4}>Nessun dettaglio</td></tr>}
            </tbody>
          </table>
        </Sec>

        {b.ddt?.length > 0 && (
          <Sec title="DDT" defaultOpen={false}>
            {b.ddt.map((dd, i) => <div key={i}><Row l="Numero" v={dd.numero} /><Row l="Data" v={fmtDate(dd.data)} /></div>)}
          </Sec>
        )}
        {b.ritenuta?.importo && (
          <Sec title="Ritenuta d'Acconto" defaultOpen={false}>
            <Row l="Tipo" v={RIT[b.ritenuta.tipo] || b.ritenuta.tipo} />
            <Row l="Importo" v={fmtEur(b.ritenuta.importo)} accent />
            <Row l="Aliquota" v={b.ritenuta.aliquota ? `${fmtNum(b.ritenuta.aliquota)}%` : ''} />
          </Sec>
        )}
        {b.cassa?.importo && (
          <Sec title="Cassa Previdenziale" defaultOpen={false}>
            <Row l="Tipo" v={b.cassa.tipo} />
            <Row l="Importo" v={fmtEur(b.cassa.importo)} accent />
          </Sec>
        )}
        {b.allegati?.length > 0 && (
          <Sec title="Allegati">
            {b.allegati.map((a, i) => {
              const mimeMap: Record<string, string> = { PDF: 'application/pdf', XML: 'text/xml', TXT: 'text/plain' }
              const href = a.hasData ? `data:${mimeMap[(a.formato || '').toUpperCase()] || 'application/octet-stream'};base64,${a.b64}` : null
              return (
                <div key={i} className="flex items-center justify-between py-1.5 border-b border-border/30 last:border-0">
                  <span className="text-xs font-medium text-primary">{a.nome}</span>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{a.formato}</span>
                    <span>{a.sizeKB > 0 ? `${a.sizeKB} KB` : ''}</span>
                    {href && <a href={href} download={a.nome} className="text-white bg-primary px-2 py-0.5 rounded text-[10px] font-semibold">⬇</a>}
                  </div>
                </div>
              )
            })}
          </Sec>
        )}

        <Sec title="Trasmissione" defaultOpen={false}>
          <Row l="Codice Destinatario" v={d.trasm.codDest} />
          <Row l="Progressivo Invio" v={d.trasm.progressivo} />
          <Row l="Telefono" v={d.ced.tel} />
          <Row l="Email" v={d.ced.email} />
        </Sec>

        <div className="text-center text-[11px] text-muted-foreground mt-4 pb-4">
          {inv.source_filename} — {inv.raw_xml ? `${Math.round(inv.raw_xml.length / 1024)} KB` : ''}
        </div>
      </div>
    </div>
  )
}

// ============================================================
// SHARED UI
// ============================================================
function Sec({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="mb-3 rounded-lg border overflow-hidden bg-card">
      <button onClick={() => setOpen(!open)} className={`w-full flex items-center px-4 py-2.5 cursor-pointer transition-colors ${open ? 'bg-primary/5 border-b' : 'hover:bg-accent/30'}`}>
        <span className="text-[13px] font-bold text-primary flex-1 text-left">{title}</span>
        {open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
      </button>
      {open && <div className="p-4">{children}</div>}
    </div>
  )
}

function Row({ l, v, accent }: { l: string; v?: string | null | number; accent?: boolean }) {
  if (!v && v !== 0) return null
  return (
    <div className="flex justify-between items-baseline py-1 border-b border-border/30 last:border-0">
      <span className="text-xs text-muted-foreground min-w-[120px]">{l}</span>
      <span className={`text-xs text-right max-w-[64%] break-words ${accent ? 'font-bold text-primary' : ''}`}>{String(v)}</span>
    </div>
  )
}
