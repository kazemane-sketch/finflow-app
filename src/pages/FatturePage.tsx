import { useState, useRef, useCallback } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { processInvoiceFile, TIPO, MP, REG, type ParseResult } from '@/lib/invoiceParser'
import { fmtNum, fmtEur, fmtDate } from '@/lib/utils'
import {
  Upload,
  FileText,
  Search,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

export default function FatturePage() {
  const [results, setResults] = useState<ParseResult[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [drag, setDrag] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    setLoading(true)
    const all: ParseResult[] = []
    for (const f of Array.from(files)) {
      try {
        all.push(...await processInvoiceFile(f))
      } catch (e: any) {
        all.push({ fn: f.name, method: "fallito", xmlLen: 0, rawXml: '', data: null as any, err: e.message })
      }
    }
    setResults(prev => [...prev, ...all])
    setLoading(false)
    const ok = all.filter(r => !r.err).length
    const err = all.filter(r => r.err).length
    if (ok > 0) toast.success(`${ok} fatture importate`)
    if (err > 0) toast.error(`${err} file con errori`)
  }, [])

  const filtered = results.filter(r => {
    if (!search) return true
    const s = search.toLowerCase()
    if (r.err) return r.fn.toLowerCase().includes(s)
    return r.fn.toLowerCase().includes(s) ||
      r.data.ced.denom.toLowerCase().includes(s) ||
      r.data.bodies[0]?.numero?.toLowerCase().includes(s)
  })

  const stats = {
    total: results.length,
    ok: results.filter(r => !r.err).length,
    err: results.filter(r => r.err).length,
    sum: results.filter(r => !r.err).reduce((s, r) => {
      const b = r.data.bodies[0]
      return s + (b?.tipo === 'TD04' ? -1 : 1) * parseFloat(b?.totale || '0')
    }, 0),
  }

  // Upload area (shown when no results or always at top)
  const UploadArea = () => (
    <div
      onDrop={e => { e.preventDefault(); setDrag(false); handleFiles(e.dataTransfer.files); }}
      onDragOver={e => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onClick={() => ref.current?.click()}
      className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
        drag ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
      }`}
    >
      <Upload className={`h-10 w-10 mx-auto mb-3 ${drag ? 'text-primary' : 'text-muted-foreground'}`} />
      <p className="font-medium">{loading ? 'Elaborazione...' : 'Trascina qui le fatture'}</p>
      <p className="text-sm text-muted-foreground mt-1">XML · P7M · ZIP — oppure clicca per sfogliare</p>
      <input
        ref={ref} type="file" multiple accept=".xml,.p7m,.zip"
        onChange={e => e.target.files && handleFiles(e.target.files)}
        className="hidden"
      />
    </div>
  )

  if (!results.length) {
    return (
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Fatture</h1>
          <p className="text-muted-foreground text-sm mt-1">Importa e visualizza le fatture elettroniche XML/P7M</p>
        </div>
        <Card>
          <CardContent className="p-6">
            <UploadArea />
          </CardContent>
        </Card>
      </div>
    )
  }

  const sel = selected !== null ? results[selected] : null

  return (
    <div className="flex h-full">
      {/* Sidebar list */}
      <div className="w-80 border-r flex flex-col shrink-0">
        {/* Stats bar */}
        <div className="px-3 py-2.5 border-b bg-card flex items-center gap-2 flex-wrap text-xs">
          <span className="font-semibold text-primary">{stats.total} file</span>
          <span className="text-emerald-600">{stats.ok} ok</span>
          {stats.err > 0 && <span className="text-destructive">{stats.err} err</span>}
          <span className="ml-auto font-bold text-emerald-700">{fmtEur(stats.sum)}</span>
        </div>

        {/* Search + upload */}
        <div className="p-2.5 border-b space-y-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Cerca fornitore, numero..."
              className="pl-8 h-8 text-xs"
            />
          </div>
          <Button variant="outline" size="sm" className="w-full text-xs" onClick={() => ref.current?.click()}>
            <Upload className="h-3.5 w-3.5 mr-1.5" /> Importa altre fatture
          </Button>
          <input
            ref={ref} type="file" multiple accept=".xml,.p7m,.zip"
            onChange={e => e.target.files && handleFiles(e.target.files)}
            className="hidden"
          />
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {filtered.map((r, i) => {
            const ri = results.indexOf(r)
            const isErr = !!r.err
            const isSel = selected === ri
            const b = r.data?.bodies?.[0]
            const nc = b?.tipo === 'TD04' || b?.tipo === 'TD05'

            return (
              <div
                key={i} onClick={() => setSelected(ri)}
                className={`px-3 py-2.5 border-b cursor-pointer transition-colors ${
                  isSel ? (isErr ? 'bg-destructive/10 border-l-2 border-l-destructive' : 'bg-primary/10 border-l-2 border-l-primary') : 'hover:bg-accent'
                }`}
              >
                {isErr ? (
                  <>
                    <div className="text-xs font-semibold text-destructive flex items-center gap-1">
                      <AlertCircle className="h-3.5 w-3.5" /> Errore
                    </div>
                    <div className="text-xs text-muted-foreground truncate mt-0.5">{r.fn}</div>
                  </>
                ) : (
                  <>
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-semibold truncate max-w-[55%]">{r.data.ced.denom}</span>
                      <span className={`text-sm font-bold ${nc ? 'text-destructive' : 'text-emerald-700'}`}>
                        {fmtEur(b?.totale)}
                      </span>
                    </div>
                    <div className="flex justify-between items-center mt-0.5">
                      <span className="text-xs text-muted-foreground">n.{b?.numero} — {fmtDate(b?.data)}</span>
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                        nc ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'
                      }`}>
                        {TIPO[b?.tipo] || b?.tipo}
                      </span>
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Detail */}
      <div className="flex-1 overflow-y-auto bg-background">
        {sel ? <InvoiceDetail r={sel} onClose={() => setSelected(null)} /> : (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <div className="text-center">
              <FileText className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Seleziona una fattura dalla lista</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================
// DETAIL COMPONENT
// ============================================================
function InvoiceDetail({ r, onClose }: { r: ParseResult; onClose: () => void }) {
  if (r.err) return (
    <div className="p-8 text-center">
      <AlertCircle className="h-12 w-12 mx-auto mb-4 text-destructive" />
      <h3 className="text-lg font-bold text-destructive">Errore di parsing</h3>
      <p className="text-sm text-muted-foreground mt-1">{r.fn}</p>
      <pre className="mt-4 p-4 bg-destructive/5 rounded-lg text-xs text-destructive text-left whitespace-pre-wrap">{r.err}</pre>
    </div>
  )

  const d = r.data
  const b = d.bodies[0]
  const nc = b?.tipo === 'TD04' || b?.tipo === 'TD05'

  return (
    <div className="p-6 space-y-5 max-w-4xl mx-auto">
      {/* Header */}
      <div className="text-center pb-4 border-b">
        <h2 className="text-xl font-bold">{TIPO[b?.tipo] || b?.tipo} N. {b?.numero}</h2>
        <div className="flex items-center justify-center gap-4 mt-2 text-sm">
          <span>Data: <strong>{fmtDate(b?.data)}</strong></span>
          <span className="px-2 py-0.5 rounded bg-primary/10 text-primary text-xs font-semibold">{d.ver}</span>
          <span className="px-2 py-0.5 rounded bg-purple-100 text-purple-700 text-xs font-semibold">{r.method}</span>
        </div>
      </div>

      {/* Da / Per */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Section title="Da: (Fornitore)">
          <Row l="Denominazione" v={d.ced.denom} accent />
          <Row l="Partita IVA" v={d.ced.piva} />
          <Row l="Codice Fiscale" v={d.ced.cf} />
          <Row l="Regime" v={d.ced.regime ? `${d.ced.regime} (${REG[d.ced.regime] || ''})` : ''} />
          <Row l="Sede" v={d.ced.sede} />
          <Row l="Email" v={d.ced.email} />
        </Section>
        <Section title="Per: (Cliente)">
          <Row l="Denominazione" v={d.ces.denom} accent />
          <Row l="Partita IVA" v={d.ces.piva} />
          <Row l="Codice Fiscale" v={d.ces.cf} />
          <Row l="Sede" v={d.ces.sede} />
        </Section>
      </div>

      {/* Linee */}
      <Section title="Dettaglio Beni e Servizi">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-primary/20 bg-primary/5">
                <th className="text-left p-2 font-semibold text-primary text-xs">Descrizione</th>
                <th className="text-right p-2 font-semibold text-primary text-xs">Qtà</th>
                <th className="text-right p-2 font-semibold text-primary text-xs">Prezzo Unit.</th>
                <th className="text-right p-2 font-semibold text-primary text-xs">IVA %</th>
                <th className="text-right p-2 font-semibold text-primary text-xs">Totale</th>
              </tr>
            </thead>
            <tbody>
              {b?.linee?.map((l, i) => (
                <tr key={i} className="border-b">
                  <td className="p-2 text-left">{l.descrizione}</td>
                  <td className="p-2 text-right text-muted-foreground">{l.quantita ? fmtNum(l.quantita) : '1'}</td>
                  <td className="p-2 text-right">{fmtNum(l.prezzoUnitario)}</td>
                  <td className="p-2 text-right">{fmtNum(l.aliquotaIVA)}%</td>
                  <td className="p-2 text-right font-semibold">{fmtNum(l.prezzoTotale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Totale */}
      <div className={`text-right p-4 rounded-lg ${nc ? 'bg-destructive/5' : 'bg-emerald-50'}`}>
        <span className="text-sm text-muted-foreground mr-3">Totale Documento</span>
        <span className={`text-2xl font-extrabold ${nc ? 'text-destructive' : 'text-emerald-700'}`}>
          {fmtEur(b?.totale)}
        </span>
      </div>

      {/* Pagamento */}
      {b?.pagamenti?.length > 0 && (
        <Section title="Pagamento">
          {b.pagamenti.map((p, i) => (
            <div key={i} className="flex flex-wrap gap-x-6 gap-y-1 text-sm py-1 border-b last:border-0">
              <span>{p.modalita ? `${p.modalita} (${MP[p.modalita] || ''})` : ''}</span>
              {p.scadenza && <span>Scadenza: <strong>{fmtDate(p.scadenza)}</strong></span>}
              <span className="font-bold">{fmtEur(p.importo)}</span>
              {p.iban && <span className="text-muted-foreground">IBAN: {p.iban}</span>}
            </div>
          ))}
        </Section>
      )}

      <p className="text-xs text-center text-muted-foreground">{r.fn} — {r.xmlLen ? `${Math.round(r.xmlLen / 1024)} KB` : ''}</p>
    </div>
  )
}

function Section({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border rounded-lg overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-4 py-2.5 bg-card hover:bg-accent/50 transition-colors">
        <span className="text-sm font-semibold text-primary">{title}</span>
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </button>
      {open && <div className="p-4 border-t">{children}</div>}
    </div>
  )
}

function Row({ l, v, accent }: { l: string; v: string; accent?: boolean }) {
  if (!v) return null
  return (
    <div className="flex justify-between items-baseline py-1 border-b border-border/50 last:border-0">
      <span className="text-xs text-muted-foreground">{l}</span>
      <span className={`text-xs text-right max-w-[60%] break-words ${accent ? 'font-bold text-primary' : ''}`}>{v}</span>
    </div>
  )
}
