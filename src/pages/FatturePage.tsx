import { useState, useRef, useCallback, useEffect } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { processInvoiceFile, TIPO, MP, REG, type ParseResult } from '@/lib/invoiceParser'
import { saveInvoicesToDB, loadInvoices, loadInvoiceDetail, type DBInvoice, type DBInvoiceDetail } from '@/lib/invoiceSaver'
import { useCompany } from '@/hooks/useCompany'
import { fmtNum, fmtEur, fmtDate } from '@/lib/utils'
import {
  Upload, FileText, Search, AlertCircle, ChevronDown, ChevronRight,
  CheckCircle2, Clock, AlertTriangle, XCircle, Database, FileCode,
  Building2, CreditCard, Download, Copy, X, Loader2, Package,
} from 'lucide-react'
import { toast } from 'sonner'

const STATUS_MAP: Record<string, { label: string; color: string; icon: any }> = {
  pending: { label: 'Da pagare', color: 'text-amber-600 bg-amber-50', icon: Clock },
  paid: { label: 'Pagata', color: 'text-emerald-600 bg-emerald-50', icon: CheckCircle2 },
  overdue: { label: 'Scaduta', color: 'text-red-600 bg-red-50', icon: AlertTriangle },
  partial: { label: 'Parziale', color: 'text-blue-600 bg-blue-50', icon: CreditCard },
}

const RECON_MAP: Record<string, { label: string; color: string }> = {
  unmatched: { label: 'Non riconciliata', color: 'text-gray-500 bg-gray-50' },
  suggested: { label: 'Suggerita', color: 'text-blue-600 bg-blue-50' },
  matched: { label: 'Riconciliata', color: 'text-emerald-600 bg-emerald-50' },
  manual: { label: 'Manuale', color: 'text-purple-600 bg-purple-50' },
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

  // Load invoices from DB
  const fetchInvoices = useCallback(async () => {
    if (!company) { setLoading(false); return }
    try {
      const data = await loadInvoices(company.id)
      setInvoices(data)
    } catch (e: any) {
      console.error('Errore caricamento fatture:', e)
    }
    setLoading(false)
  }, [company])

  useEffect(() => { fetchInvoices() }, [fetchInvoices])

  // Load detail when selected
  useEffect(() => {
    if (!selectedId) { setDetail(null); return }
    setDetailLoading(true)
    loadInvoiceDetail(selectedId).then(d => {
      setDetail(d)
      setDetailLoading(false)
    })
  }, [selectedId])

  // Import files → parse → save to DB
  const handleFiles = useCallback(async (files: FileList | File[]) => {
    setImporting(true)
    const allResults: ParseResult[] = []

    for (const f of Array.from(files)) {
      try {
        allResults.push(...await processInvoiceFile(f))
      } catch (e: any) {
        allResults.push({ fn: f.name, method: 'fallito', xmlLen: 0, rawXml: '', data: null as any, err: e.message })
      }
    }

    const okResults = allResults.filter(r => !r.err && r.data)
    const errCount = allResults.filter(r => r.err).length

    if (okResults.length === 0) {
      toast.error(`Nessuna fattura valida trovata. ${errCount} errori.`)
      setImporting(false)
      return
    }

    try {
      // Ensure company exists (auto-create from first invoice)
      const firstInvoice = okResults[0]
      const companyId = await ensureCompany(firstInvoice.data.ces)

      // Save to DB
      const saveResults = await saveInvoicesToDB(okResults, companyId)
      const saved = saveResults.filter(r => r.success && !r.error?.includes('Duplicato')).length
      const dupes = saveResults.filter(r => r.error?.includes('Duplicato')).length
      const failed = saveResults.filter(r => !r.success).length

      let msg = `${saved} fatture importate`
      if (dupes > 0) msg += `, ${dupes} già presenti`
      if (failed > 0) msg += `, ${failed} errori`
      if (errCount > 0) msg += `, ${errCount} file non validi`

      if (saved > 0) toast.success(msg)
      else if (dupes > 0) toast.info(msg)
      else toast.error(msg)

      // Refresh list
      await fetchInvoices()
    } catch (e: any) {
      toast.error('Errore salvataggio: ' + e.message)
    }

    setImporting(false)
  }, [ensureCompany, fetchInvoices])

  // Filtered invoices
  const filtered = invoices.filter(inv => {
    if (statusFilter !== 'all' && inv.payment_status !== statusFilter) return false
    if (!search) return true
    const s = search.toLowerCase()
    return (
      inv.counterparty?.name?.toLowerCase().includes(s) ||
      inv.number?.toLowerCase().includes(s) ||
      inv.source_filename?.toLowerCase().includes(s)
    )
  })

  // Stats
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
        {/* Stats header */}
        <div className="px-4 py-3 border-b space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold">Fatture</h2>
            <span className="text-xs font-bold text-emerald-700">{fmtEur(stats.totalAmount)}</span>
          </div>

          {/* Status filters */}
          {invoices.length > 0 && (
            <div className="flex gap-1">
              {[
                { key: 'all', label: `Tutte ${stats.total}`, color: 'bg-gray-100 text-gray-700' },
                { key: 'pending', label: `${stats.pending}`, color: 'bg-amber-50 text-amber-700', icon: '⏳' },
                { key: 'overdue', label: `${stats.overdue}`, color: 'bg-red-50 text-red-700', icon: '⚠' },
                { key: 'paid', label: `${stats.paid}`, color: 'bg-emerald-50 text-emerald-700', icon: '✓' },
              ].map(f => (
                <button
                  key={f.key}
                  onClick={() => setStatusFilter(f.key)}
                  className={`flex-1 text-[10px] font-semibold py-1 rounded transition-all ${
                    statusFilter === f.key ? 'ring-1 ring-primary ' + f.color : 'bg-gray-50 text-gray-400 hover:bg-gray-100'
                  }`}
                >
                  {f.icon ? `${f.icon} ${f.label}` : f.label}
                </button>
              ))}
            </div>
          )}

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Cerca fornitore, numero..."
              className="pl-8 h-8 text-xs"
            />
          </div>

          {/* Import button */}
          <Button
            variant="outline" size="sm"
            className="w-full text-xs gap-1.5"
            onClick={() => ref.current?.click()}
            disabled={importing}
          >
            {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            {importing ? 'Importazione...' : 'Importa fatture XML/P7M'}
          </Button>
          <input
            ref={ref} type="file" multiple accept=".xml,.p7m,.zip"
            onChange={e => e.target.files && handleFiles(e.target.files)}
            className="hidden"
          />
        </div>

        {/* Invoice list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 px-4">
              <FileText className="h-10 w-10 mx-auto mb-3 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">
                {invoices.length === 0 ? 'Nessuna fattura importata' : 'Nessun risultato'}
              </p>
              {invoices.length === 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  Clicca "Importa fatture" per iniziare
                </p>
              )}
            </div>
          ) : (
            filtered.map(inv => (
              <InvoiceCard
                key={inv.id} inv={inv}
                selected={selectedId === inv.id}
                onClick={() => setSelectedId(inv.id)}
              />
            ))
          )}
        </div>
      </div>

      {/* Detail panel */}
      <div className="flex-1 overflow-y-auto bg-background">
        {detailLoading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : detail ? (
          <InvoiceDetail inv={detail} onClose={() => setSelectedId(null)} />
        ) : (
          <EmptyDetail onImport={() => ref.current?.click()} importing={importing} />
        )}
      </div>
    </div>
  )
}

// ============================================================
// INVOICE CARD (sidebar list item)
// ============================================================
function InvoiceCard({ inv, selected, onClick }: { inv: DBInvoice; selected: boolean; onClick: () => void }) {
  const nc = inv.doc_type === 'TD04' || inv.doc_type === 'TD05'
  const status = STATUS_MAP[inv.payment_status] || STATUS_MAP.pending
  const StatusIcon = status.icon

  return (
    <div
      onClick={onClick}
      className={`px-4 py-3 border-b cursor-pointer transition-all ${
        selected ? 'bg-primary/5 border-l-2 border-l-primary' : 'hover:bg-accent/50'
      }`}
    >
      <div className="flex justify-between items-start gap-2">
        <span className="text-sm font-semibold truncate flex-1">{inv.counterparty?.name || '—'}</span>
        <span className={`text-sm font-bold shrink-0 ${nc ? 'text-red-600' : 'text-emerald-700'}`}>
          {nc ? '-' : ''}{fmtEur(inv.total_amount)}
        </span>
      </div>
      <div className="flex justify-between items-center mt-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">n.{inv.number}</span>
          <span className="text-[11px] text-muted-foreground">{fmtDate(inv.date)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded ${status.color}`}>
            <StatusIcon className="h-3 w-3" />
            {status.label}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-1">
        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${nc ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'}`}>
          {TIPO[inv.doc_type] || inv.doc_type}
        </span>
      </div>
    </div>
  )
}

// ============================================================
// EMPTY DETAIL STATE
// ============================================================
function EmptyDetail({ onImport, importing }: { onImport: () => void; importing: boolean }) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center max-w-md px-8">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-50 to-indigo-50 mb-6">
          <FileText className="h-10 w-10 text-blue-400" />
        </div>
        <h3 className="text-lg font-semibold mb-2">Fatture Elettroniche</h3>
        <p className="text-sm text-muted-foreground mb-6">
          Importa file XML, P7M o ZIP per visualizzare e gestire le tue fatture.
          I dati vengono estratti automaticamente e salvati nel database.
        </p>
        <Button onClick={onImport} disabled={importing} className="gap-2">
          {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {importing ? 'Importazione...' : 'Importa fatture'}
        </Button>
        <div className="flex items-center justify-center gap-6 mt-6 text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><FileCode className="h-3.5 w-3.5" /> XML</span>
          <span className="flex items-center gap-1"><Package className="h-3.5 w-3.5" /> P7M</span>
          <span className="flex items-center gap-1"><Database className="h-3.5 w-3.5" /> ZIP</span>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// INVOICE DETAIL VIEW
// ============================================================
function InvoiceDetail({ inv, onClose }: { inv: DBInvoiceDetail; onClose: () => void }) {
  const [showXml, setShowXml] = useState(false)
  const nc = inv.doc_type === 'TD04' || inv.doc_type === 'TD05'
  const status = STATUS_MAP[inv.payment_status] || STATUS_MAP.pending
  const recon = RECON_MAP[inv.reconciliation_status] || RECON_MAP.unmatched
  const StatusIcon = status.icon

  return (
    <div className="p-6 space-y-5 max-w-4xl mx-auto">
      {/* Toolbar */}
      <div className="flex items-center justify-between" data-noprint>
        <Button variant="ghost" size="sm" onClick={onClose} className="text-xs gap-1">
          ← Lista
        </Button>
        <div className="flex gap-2">
          {inv.raw_xml && (
            <Button
              variant={showXml ? 'default' : 'outline'} size="sm"
              className="text-xs gap-1"
              onClick={() => setShowXml(!showXml)}
            >
              <FileCode className="h-3.5 w-3.5" />
              {showXml ? 'Chiudi XML' : 'XML'}
            </Button>
          )}
        </div>
      </div>

      {/* XML Viewer */}
      {showXml && inv.raw_xml && (
        <div className="rounded-lg overflow-hidden border bg-[#1a1d24]">
          <div className="flex items-center justify-between px-3 py-2 bg-[#252830]">
            <span className="text-xs font-medium text-blue-300">XML Sorgente — {Math.round(inv.raw_xml.length / 1024)} KB</span>
            <Button
              variant="ghost" size="sm"
              className="h-6 text-[10px] text-gray-400 hover:text-white"
              onClick={() => navigator.clipboard?.writeText(inv.raw_xml!)}
            >
              <Copy className="h-3 w-3 mr-1" /> Copia
            </Button>
          </div>
          <pre className="p-3 text-xs text-gray-300 font-mono overflow-auto max-h-96 whitespace-pre-wrap break-all leading-relaxed">
            {inv.raw_xml}
          </pre>
        </div>
      )}

      {/* Header */}
      <div className="text-center pb-5 border-b">
        <div className="flex items-center justify-center gap-3 mb-3">
          <span className={`text-[11px] font-semibold px-2 py-1 rounded ${nc ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'}`}>
            {TIPO[inv.doc_type] || inv.doc_type}
          </span>
          <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded ${status.color}`}>
            <StatusIcon className="h-3 w-3" /> {status.label}
          </span>
          <span className={`text-[11px] font-semibold px-2 py-1 rounded ${recon.color}`}>
            {recon.label}
          </span>
        </div>
        <h2 className="text-2xl font-bold tracking-tight">
          {TIPO[inv.doc_type] || inv.doc_type} N. {inv.number}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          {fmtDate(inv.date)}
          {inv.payment_due_date && <> · Scadenza: <strong>{fmtDate(inv.payment_due_date)}</strong></>}
        </p>
      </div>

      {/* Parties */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Section title="Fornitore" icon={Building2}>
          <Row l="Denominazione" v={inv.counterparty?.name} accent />
          <Row l="Partita IVA" v={inv.counterparty?.vat_number} />
          <Row l="Codice Fiscale" v={inv.counterparty?.fiscal_code} />
          <Row l="Sede" v={[inv.counterparty?.address, inv.counterparty?.city, inv.counterparty?.province ? `(${inv.counterparty.province})` : ''].filter(Boolean).join(', ')} />
          <Row l="Email" v={inv.counterparty?.email} />
        </Section>

        <Section title="Importi" icon={CreditCard}>
          <Row l="Imponibile" v={inv.taxable_amount != null ? fmtEur(inv.taxable_amount) : ''} />
          <Row l="Imposta (IVA)" v={inv.tax_amount != null ? fmtEur(inv.tax_amount) : ''} />
          {inv.withholding_amount && <Row l="Ritenuta d'acconto" v={fmtEur(inv.withholding_amount)} />}
          {inv.stamp_amount && <Row l="Bollo" v={fmtEur(inv.stamp_amount)} />}
          <div className={`mt-3 p-3 rounded-lg text-right ${nc ? 'bg-red-50' : 'bg-emerald-50'}`}>
            <span className="text-xs text-muted-foreground">Totale Documento</span>
            <div className={`text-2xl font-extrabold ${nc ? 'text-red-600' : 'text-emerald-700'}`}>
              {nc ? '- ' : ''}{fmtEur(inv.total_amount)}
            </div>
          </div>
        </Section>
      </div>

      {/* Lines */}
      {inv.invoice_lines?.length > 0 && (
        <Section title="Dettaglio Beni e Servizi" icon={FileText} defaultOpen>
          <div className="overflow-x-auto -mx-4">
            <table className="w-full text-sm min-w-[600px]">
              <thead>
                <tr className="border-b-2 border-primary/20">
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-primary bg-primary/5 rounded-tl-lg">Descrizione</th>
                  <th className="text-right px-3 py-2.5 text-xs font-semibold text-primary bg-primary/5">Qtà</th>
                  <th className="text-right px-3 py-2.5 text-xs font-semibold text-primary bg-primary/5">Prezzo Unit.</th>
                  <th className="text-right px-3 py-2.5 text-xs font-semibold text-primary bg-primary/5">IVA %</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-primary bg-primary/5 rounded-tr-lg">Totale</th>
                </tr>
              </thead>
              <tbody>
                {inv.invoice_lines
                  .sort((a, b) => (a.line_number || 0) - (b.line_number || 0))
                  .map((l, i) => (
                  <tr key={l.id} className="border-b border-border/50 hover:bg-accent/30 transition-colors">
                    <td className="px-4 py-2.5 text-left">
                      <div className="font-medium text-[13px]">{l.description}</div>
                      {l.article_code && <div className="text-[11px] text-muted-foreground mt-0.5">{l.article_code}</div>}
                    </td>
                    <td className="px-3 py-2.5 text-right text-muted-foreground text-[13px]">
                      {l.quantity != null ? fmtNum(l.quantity) : '1'}
                      {l.unit_measure && <span className="text-[10px] ml-0.5">{l.unit_measure}</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right text-[13px]">{l.unit_price != null ? fmtNum(l.unit_price) : ''}</td>
                    <td className="px-3 py-2.5 text-right text-[13px]">{l.vat_rate != null ? `${fmtNum(l.vat_rate)}%` : ''}</td>
                    <td className="px-4 py-2.5 text-right font-semibold text-[13px]">{l.total_price != null ? fmtNum(l.total_price) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Payment */}
      {inv.payment_method && (
        <Section title="Pagamento" icon={CreditCard}>
          <Row l="Modalità" v={MP[inv.payment_method] || inv.payment_method} />
          <Row l="Condizioni" v={inv.payment_terms === 'TP02' ? 'Completo' : inv.payment_terms === 'TP01' ? 'A rate' : inv.payment_terms} />
          <Row l="Scadenza" v={fmtDate(inv.payment_due_date)} accent />
        </Section>
      )}

      {/* Notes */}
      {inv.notes && (
        <Section title="Note / Causale">
          <p className="text-sm whitespace-pre-wrap">{inv.notes}</p>
        </Section>
      )}

      {/* Meta */}
      <div className="text-center text-[11px] text-muted-foreground pt-4 border-t space-y-0.5">
        <p>{inv.source_filename} · {inv.parse_method} · {inv.xml_version}</p>
        <p className="font-mono text-[10px]">ID: {inv.id}</p>
      </div>
    </div>
  )
}

// ============================================================
// SHARED COMPONENTS
// ============================================================
function Section({ title, icon: Icon, children, defaultOpen = true }: {
  title: string; icon?: any; children: React.ReactNode; defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-lg border overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-3 bg-card hover:bg-accent/30 transition-colors"
      >
        {Icon && <Icon className="h-4 w-4 text-primary" />}
        <span className="text-sm font-semibold text-foreground flex-1 text-left">{title}</span>
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </button>
      {open && <div className="px-4 py-3 border-t bg-card">{children}</div>}
    </div>
  )
}

function Row({ l, v, accent }: { l: string; v?: string | null; accent?: boolean }) {
  if (!v) return null
  return (
    <div className="flex justify-between items-baseline py-1.5 border-b border-border/40 last:border-0">
      <span className="text-xs text-muted-foreground">{l}</span>
      <span className={`text-xs text-right max-w-[60%] break-words ${accent ? 'font-bold text-primary' : 'font-medium'}`}>{v}</span>
    </div>
  )
}
