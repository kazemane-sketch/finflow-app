import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { processInvoiceFile, TIPO, MP, REG, type ParseResult, type ParsedInvoice } from '@/lib/invoiceParser'
import { saveInvoicesToDB, loadInvoices, loadInvoiceDetail, type DBInvoice, type DBInvoiceDetail } from '@/lib/invoiceSaver'
import { useCompany } from '@/hooks/useCompany'
import { fmtNum, fmtEur, fmtDate } from '@/lib/utils'
import {
  Upload, FileText, Search, ChevronDown, ChevronRight,
  CheckCircle2, Clock, AlertTriangle, CreditCard,
  Database, FileCode, Package, Loader2, Copy,
} from 'lucide-react'
import { toast } from 'sonner'

// Re-parse raw XML to get full parsed data (all fields fattura-v3 shows)
import { reparseXml } from '@/lib/invoiceParser'

// ============================================================
// LOOKUP TABLES (complete, matching fattura-v3)
// ============================================================
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

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    setImporting(true)
    const allResults: ParseResult[] = []
    for (const f of Array.from(files)) {
      try { allResults.push(...await processInvoiceFile(f)) }
      catch (e: any) { allResults.push({ fn: f.name, method: 'fallito', xmlLen: 0, rawXml: '', data: null as any, err: e.message }) }
    }
    const okResults = allResults.filter(r => !r.err && r.data)
    const errCount = allResults.filter(r => r.err).length
    if (okResults.length === 0) { toast.error(`Nessuna fattura valida. ${errCount} errori.`); setImporting(false); return }
    try {
      const companyId = await ensureCompany(okResults[0].data.ces)
      const saveResults = await saveInvoicesToDB(okResults, companyId)
      const saved = saveResults.filter(r => r.success && !r.error?.includes('Duplicato')).length
      const dupes = saveResults.filter(r => r.error?.includes('Duplicato')).length
      const failed = saveResults.filter(r => !r.success).length
      let msg = `${saved} fatture importate`
      if (dupes > 0) msg += `, ${dupes} già presenti`
      if (failed > 0) msg += `, ${failed} errori`
      if (errCount > 0) msg += `, ${errCount} file non validi`
      if (saved > 0) toast.success(msg); else if (dupes > 0) toast.info(msg); else toast.error(msg)
      await fetchInvoices()
    } catch (e: any) { toast.error('Errore salvataggio: ' + e.message) }
    setImporting(false)
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
          <Button variant="outline" size="sm" className="w-full text-xs gap-1.5" onClick={() => ref.current?.click()} disabled={importing}>
            {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            {importing ? 'Importazione...' : 'Importa fatture XML/P7M'}
          </Button>
          <input ref={ref} type="file" multiple accept=".xml,.p7m,.zip" onChange={e => e.target.files && handleFiles(e.target.files)} className="hidden" />
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
            filtered.map(inv => <InvoiceCard key={inv.id} inv={inv} selected={selectedId === inv.id} onClick={() => setSelectedId(inv.id)} />)
          )}
        </div>
      </div>

      {/* Detail */}
      <div className="flex-1 overflow-y-auto bg-background">
        {detailLoading ? (
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
        )}
      </div>
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

  // Re-parse raw XML to get ALL original data
  const parsed = useMemo<ParsedInvoice | null>(() => {
    if (!inv.raw_xml) return null
    try { return reparseXml(inv.raw_xml) }
    catch { return null }
  }, [inv.raw_xml])

  const d = parsed
  const b = d?.bodies?.[0]
  const nc = b?.tipo === 'TD04' || b?.tipo === 'TD05'
  const hasContratti = (b?.contratti?.length ?? 0) > 0 || (b?.ordini?.length ?? 0) > 0

  // Status badges
  const status = STATUS_MAP[inv.payment_status] || STATUS_MAP.pending
  const StatusIcon = status.icon

  // If no parsed data, show minimal view from DB
  if (!d || !b) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <Button variant="ghost" size="sm" onClick={onClose} className="text-xs mb-4">← Lista</Button>
        <div className="text-center py-8 text-muted-foreground">XML originale non disponibile per la vista dettagliata.</div>
      </div>
    )
  }

  const xmlDataUrl = inv.raw_xml ? "data:text/xml;charset=utf-8," + encodeURIComponent(inv.raw_xml) : null
  const xmlFileName = (inv.source_filename || 'fattura').replace(/\.p7m$/i, '').replace(/\.xml$/i, '') + '.xml'

  return (
    <div className="p-5 overflow-y-auto">
      <div className="max-w-5xl mx-auto">

        {/* Toolbar */}
        <div className="flex items-center justify-between mb-4">
          <Button variant="ghost" size="sm" onClick={onClose} className="text-xs gap-1">← Lista</Button>
          <div className="flex gap-2">
            <Button variant={showXml ? 'default' : 'outline'} size="sm" className="text-xs gap-1" onClick={() => setShowXml(!showXml)}>
              <FileCode className="h-3.5 w-3.5" />{showXml ? '✕ Chiudi XML' : '〈/〉 Vedi XML'}
            </Button>
            {xmlDataUrl && (
              <a href={xmlDataUrl} download={xmlFileName} className="inline-flex items-center gap-1 border rounded-md px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors">
                ⬇ Scarica XML
              </a>
            )}
          </div>
        </div>

        {/* XML Viewer */}
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

        {/* Riferimenti */}
        {hasContratti && (
          <Sec title="Riferimenti">
            {b.contratti.map((c, i) => <Row key={`c${i}`} l="Rif. Contratto" v={[c.id, c.data ? fmtDate(c.data) : '', c.cig ? `CIG:${c.cig}` : '', c.cup ? `CUP:${c.cup}` : ''].filter(Boolean).join(' — ')} />)}
            {b.ordini.map((o, i) => <Row key={`o${i}`} l="Rif. Ordine" v={[o.id, o.data ? fmtDate(o.data) : '', o.cig ? `CIG:${o.cig}` : '', o.cup ? `CUP:${o.cup}` : ''].filter(Boolean).join(' — ')} />)}
          </Sec>
        )}

        {/* Causali */}
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

        {/* Riepilogo IVA e Totali */}
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
                  <td className="px-3 py-1.5 text-left">
                    {fmtNum(r.aliquota)}%
                    {r.natura ? ` - ${r.natura} (${NAT[r.natura] || ''})` : ''}
                    {r.rifNorm ? ` - ${r.rifNorm}` : ''}
                  </td>
                  <td className="px-3 py-1.5 text-right font-semibold">{fmtNum(r.imposta)}</td>
                  <td className="px-3 py-1.5 text-right font-semibold">{fmtNum(r.imponibile)}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-primary/20">
                <td className="px-3 py-1.5 text-left font-bold" colSpan={2}>Totale Imposta e Imponibile</td>
                <td className="px-3 py-1.5 text-right font-bold text-primary">{fmtNum(b.riepilogo?.reduce((s, r) => s + parseFloat(r.imposta || '0'), 0))}</td>
                <td className="px-3 py-1.5 text-right font-bold text-primary">{fmtNum(b.riepilogo?.reduce((s, r) => s + parseFloat(r.imponibile || '0'), 0))}</td>
              </tr>
            </tbody>
          </table>

          {/* Bollo / Sconto / Divisa / Totale */}
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
            <thead>
              <tr className="border-b-2 border-primary/20 bg-primary/5">
                <th className="text-left px-3 py-2 font-semibold text-primary text-[11px]">Modalità Pagamento</th>
                <th className="text-left px-3 py-2 font-semibold text-primary text-[11px]">IBAN</th>
                <th className="text-right px-3 py-2 font-semibold text-primary text-[11px]">Data Scadenza</th>
                <th className="text-right px-3 py-2 font-semibold text-primary text-[11px]">Importo</th>
              </tr>
            </thead>
            <tbody>
              {b.pagamenti?.length > 0 ? b.pagamenti.map((p, i) => (
                <tr key={i} className="border-b border-border/40">
                  <td className="px-3 py-1.5 text-left">
                    {p.modalita ? `${p.modalita} (${MP[p.modalita] || ''})` : ''}
                    {b.condPag ? ` - ${b.condPag} (${CP[b.condPag] || ''})` : ''}
                  </td>
                  <td className="px-3 py-1.5 text-left">{p.iban || ''}</td>
                  <td className="px-3 py-1.5 text-right">{fmtDate(p.scadenza)}</td>
                  <td className="px-3 py-1.5 text-right font-bold">{fmtEur(p.importo)}</td>
                </tr>
              )) : (
                <tr><td className="px-3 py-1.5 text-muted-foreground" colSpan={4}>Nessun dettaglio pagamento</td></tr>
              )}
            </tbody>
          </table>
        </Sec>

        {/* DDT */}
        {b.ddt?.length > 0 && (
          <Sec title="Documenti di Trasporto" defaultOpen={false}>
            {b.ddt.map((dd, i) => <div key={i}><Row l="DDT Numero" v={dd.numero} /><Row l="DDT Data" v={fmtDate(dd.data)} /></div>)}
          </Sec>
        )}

        {/* Ritenuta */}
        {b.ritenuta?.importo && (
          <Sec title="Ritenuta d'Acconto" defaultOpen={false}>
            <Row l="Tipo" v={RIT[b.ritenuta.tipo] || b.ritenuta.tipo} />
            <Row l="Importo" v={fmtEur(b.ritenuta.importo)} accent />
            <Row l="Aliquota" v={b.ritenuta.aliquota ? `${fmtNum(b.ritenuta.aliquota)}%` : ''} />
            <Row l="Causale Pag." v={b.ritenuta.causale} />
          </Sec>
        )}

        {/* Cassa */}
        {b.cassa?.importo && (
          <Sec title="Cassa Previdenziale" defaultOpen={false}>
            <Row l="Tipo Cassa" v={b.cassa.tipo} />
            <Row l="Importo Contributo" v={fmtEur(b.cassa.importo)} accent />
            <Row l="Aliquota Cassa" v={b.cassa.al ? `${fmtNum(b.cassa.al)}%` : ''} />
          </Sec>
        )}

        {/* Allegati */}
        {b.allegati?.length > 0 && (
          <Sec title="File Allegati">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b-2 border-primary/20 bg-primary/5">
                  <th className="text-left px-3 py-2 font-semibold text-primary text-[11px]">Nome File</th>
                  <th className="text-left px-3 py-2 font-semibold text-primary text-[11px]">Formato</th>
                  <th className="text-left px-3 py-2 font-semibold text-primary text-[11px]">Descrizione</th>
                  <th className="text-right px-3 py-2 font-semibold text-primary text-[11px]">Dimensione</th>
                  <th className="text-right px-3 py-2 font-semibold text-primary text-[11px]">Scarica</th>
                </tr>
              </thead>
              <tbody>
                {b.allegati.map((a, i) => {
                  const mimeMap: Record<string, string> = { PDF: 'application/pdf', XML: 'text/xml', TXT: 'text/plain', CSV: 'text/csv', PNG: 'image/png', JPG: 'image/jpeg' }
                  const mime = mimeMap[(a.formato || '').toUpperCase()] || 'application/octet-stream'
                  const href = a.hasData ? `data:${mime};base64,${a.b64}` : null
                  return (
                    <tr key={i} className="border-b border-border/40">
                      <td className="px-3 py-1.5 text-left text-primary font-medium">{a.nome}</td>
                      <td className="px-3 py-1.5 text-left">{a.formato || '—'}</td>
                      <td className="px-3 py-1.5 text-left">{a.descrizione || '—'}</td>
                      <td className="px-3 py-1.5 text-right">{a.sizeKB > 0 ? `${a.sizeKB} KB` : '—'}</td>
                      <td className="px-3 py-1.5 text-right">
                        {href ? <a href={href} download={a.nome || 'allegato'} className="text-xs font-semibold text-white bg-primary px-2 py-1 rounded">⬇ Scarica</a> : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </Sec>
        )}

        {/* Trasmissione */}
        <Sec title="Trasmissione" defaultOpen={false}>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b-2 border-primary/20 bg-primary/5">
                <th className="text-left px-3 py-2 font-semibold text-primary text-[11px]">Codice Destinatario</th>
                <th className="text-left px-3 py-2 font-semibold text-primary text-[11px]">Progressivo Invio</th>
                <th className="text-left px-3 py-2 font-semibold text-primary text-[11px]">Telefono</th>
                <th className="text-left px-3 py-2 font-semibold text-primary text-[11px]">Email</th>
              </tr>
            </thead>
            <tbody><tr className="border-b border-border/40">
              <td className="px-3 py-1.5 text-left">{d.trasm.codDest}</td>
              <td className="px-3 py-1.5 text-left">{d.trasm.progressivo}</td>
              <td className="px-3 py-1.5 text-left">{d.ced.tel || '—'}</td>
              <td className="px-3 py-1.5 text-left">{d.ced.email || '—'}</td>
            </tr></tbody>
          </table>
        </Sec>

        {/* Footer */}
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
