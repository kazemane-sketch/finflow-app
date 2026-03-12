import { useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { fmtDate, fmtEur } from '@/lib/utils'
import {
  FileText,
  Landmark,
  Link2,
  CalendarClock,
  TrendingUp,
  TrendingDown,
  AlertCircle,
  Receipt,
  BarChart3,
} from 'lucide-react'
import { useCompany } from '@/hooks/useCompany'
import { getVatCurrentSummary, formatVatPeriodLabel, type VatCurrentSummary } from '@/lib/vat'
import { listScadenzarioRows, touchOverdueInstallments, type ScadenzarioRow } from '@/lib/scadenzario'
import { supabase } from '@/integrations/supabase/client'
import {
  ResponsiveContainer,
  ComposedChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Bar,
  Line,
  Legend,
} from 'recharts'

// ─── Types ───
interface MonthlyData {
  month: string       // 'YYYY-MM'
  monthLabel: string   // 'Gen 25', 'Feb 25'
  ricavi: number       // fatture attive (out) — denaro in entrata
  costi: number        // fatture passive (in) — denaro in uscita
  ebitda: number       // ricavi - costi
}

interface DashboardKpis {
  invoiceCount: number
  bankTxCount: number
  unreconciled: number
  upcomingDue: number
}

// ─── P&L (Conto Economico) types ───
type CoaSection =
  | 'revenue' | 'cost_production' | 'cost_personnel' | 'depreciation'
  | 'other_costs' | 'financial' | 'extraordinary'

interface PlAccountRow {
  code: string
  name: string
  section: CoaSection
  total: number
}

interface PlSectionTotals {
  revenue: number
  cost_production: number
  cost_personnel: number
  depreciation: number
  other_costs: number
  financial: number
  extraordinary: number
}

const PL_SECTION_ORDER: { key: keyof PlSectionTotals; label: string; sign: 1 | -1 }[] = [
  { key: 'revenue',         label: 'Valore della produzione',      sign: 1 },
  { key: 'cost_production', label: 'Costi della produzione',       sign: -1 },
  { key: 'cost_personnel',  label: 'Costi del personale',          sign: -1 },
  { key: 'other_costs',     label: 'Altri costi operativi',        sign: -1 },
]

// Sections below EBITDA
const PL_BELOW_EBITDA: { key: keyof PlSectionTotals; label: string; sign: 1 | -1 }[] = [
  { key: 'depreciation',    label: 'Ammortamenti e svalutazioni',  sign: -1 },
  { key: 'financial',       label: 'Proventi e oneri finanziari',  sign: -1 },
  { key: 'extraordinary',   label: 'Componenti straordinarie',     sign: -1 },
]

// ─── Italian month labels ───
const MESI = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic']

function toMonthLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return `${MESI[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`
}

function toMonthKey(dateStr: string): string {
  return dateStr.slice(0, 7) // 'YYYY-MM'
}

// ─── Compact number formatter for Y axis ───
function formatCompactEur(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(0)}k`
  return String(Math.round(v))
}

// ─── Custom Tooltip ───
function EbitdaTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white/95 backdrop-blur-sm border border-slate-200 rounded-lg shadow-lg px-4 py-3 text-[12px]">
      <p className="font-semibold text-slate-700 mb-2">{label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: p.color }} />
            <span className="text-slate-500">{p.name}</span>
          </div>
          <span className="font-semibold text-slate-800">{fmtEur(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

// ─── P&L Section Block (collapsible section with detail rows) ───
function PlSectionBlock({ label, rows, total, isRevenue }: {
  label: string
  rows: PlAccountRow[]
  total: number
  isRevenue: boolean
}) {
  const [open, setOpen] = useState(false)
  const totalColor = isRevenue
    ? 'text-emerald-700'
    : total > 0 ? 'text-red-700' : 'text-slate-700'

  return (
    <>
      {/* Section header row — clickable to expand detail */}
      <tr
        className="bg-slate-50/50 cursor-pointer hover:bg-slate-100/60 transition-colors group"
        onClick={() => setOpen(o => !o)}
      >
        <td className="px-4 py-2" />
        <td className="px-4 py-2 font-semibold text-slate-700 text-[12px]">
          <span className="inline-flex items-center gap-1.5">
            <span className={`text-[9px] text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
            {label}
            <span className="text-[10px] text-slate-400 font-normal">({rows.length})</span>
          </span>
        </td>
        <td className={`text-right px-4 py-2 font-semibold text-[12px] ${totalColor}`}>
          {isRevenue ? '' : '−'}{fmtEur(Math.abs(total))}
        </td>
      </tr>

      {/* Detail rows (visible when expanded) */}
      {open && rows.map(r => (
        <tr key={r.code} className="hover:bg-slate-50/50">
          <td className="px-4 py-1.5 text-[11px] text-slate-400 font-mono">{r.code}</td>
          <td className="px-4 py-1.5 text-[11px] text-slate-600 pl-10">{r.name}</td>
          <td className="text-right px-4 py-1.5 text-[11px] text-slate-600 tabular-nums">
            {fmtEur(r.total)}
          </td>
        </tr>
      ))}
    </>
  )
}

export default function DashboardPage() {
  const { company } = useCompany()
  const navigate = useNavigate()
  const [vatSummary, setVatSummary] = useState<VatCurrentSummary | null>(null)
  const [upcomingRows, setUpcomingRows] = useState<ScadenzarioRow[]>([])
  const [monthlyData, setMonthlyData] = useState<MonthlyData[]>([])
  const [kpiData, setKpiData] = useState<DashboardKpis>({ invoiceCount: 0, bankTxCount: 0, unreconciled: 0, upcomingDue: 0 })
  const [chartLoading, setChartLoading] = useState(true)
  const [plRows, setPlRows] = useState<PlAccountRow[]>([])
  const [plLoading, setPlLoading] = useState(true)

  // ─── Load P&L (Conto Economico) data ───
  useEffect(() => {
    let mounted = true
    async function loadPL() {
      if (!company?.id) { if (mounted) { setPlRows([]); setPlLoading(false) }; return }
      setPlLoading(true)
      try {
        // Query classified invoice lines with their account section info
        // invoice_lines → invoices (for company filter) → chart_of_accounts (for section)
        const { data, error } = await supabase
          .from('invoice_lines')
          .select(`
            total_price,
            account_id,
            chart_of_accounts!inner ( code, name, section, is_header ),
            invoices!inner ( company_id, direction, date )
          `)
          .eq('invoices.company_id', company.id)
          .not('account_id', 'is', null)

        if (error) throw error
        if (!data?.length) { if (mounted) { setPlRows([]); setPlLoading(false) }; return }

        // Current year filter
        const currentYear = String(new Date().getFullYear())

        // Aggregate by account (code + name + section)
        const accountMap = new Map<string, PlAccountRow>()
        for (const line of data as any[]) {
          const coa = line.chart_of_accounts
          const inv = line.invoices
          if (!coa || !inv) continue
          // Skip balance sheet sections
          if (['assets', 'liabilities', 'equity'].includes(coa.section)) continue
          // Skip headers
          if (coa.is_header) continue
          // Filter current year
          if (!inv.date?.startsWith(currentYear)) continue

          const amt = Number(line.total_price) || 0
          if (amt === 0) continue

          const key = coa.code as string
          const existing = accountMap.get(key)
          if (existing) {
            existing.total += amt
          } else {
            accountMap.set(key, {
              code: coa.code,
              name: coa.name,
              section: coa.section as CoaSection,
              total: amt,
            })
          }
        }

        // Sort by section order then code
        const sectionOrder: Record<string, number> = {
          revenue: 0, cost_production: 1, cost_personnel: 2,
          other_costs: 3, depreciation: 4, financial: 5, extraordinary: 6,
        }
        const rows = Array.from(accountMap.values())
          .filter(r => Math.abs(r.total) >= 0.01)
          .sort((a, b) => {
            const so = (sectionOrder[a.section] ?? 99) - (sectionOrder[b.section] ?? 99)
            return so !== 0 ? so : a.code.localeCompare(b.code)
          })

        if (mounted) setPlRows(rows)
      } catch (err) {
        console.error('Dashboard P&L load error:', err)
      } finally {
        if (mounted) setPlLoading(false)
      }
    }
    loadPL()
    return () => { mounted = false }
  }, [company?.id])

  // ─── Load VAT summary ───
  useEffect(() => {
    let mounted = true
    async function loadVatSummary() {
      if (!company?.id) { if (mounted) setVatSummary(null); return }
      try {
        const data = await getVatCurrentSummary(company.id)
        if (mounted) setVatSummary(data)
      } catch { if (mounted) setVatSummary(null) }
    }
    loadVatSummary()
    return () => { mounted = false }
  }, [company?.id])

  // ─── Load upcoming deadlines ───
  useEffect(() => {
    let mounted = true
    async function loadUpcoming() {
      if (!company?.id) { if (mounted) setUpcomingRows([]); return }
      try {
        await touchOverdueInstallments(company.id)
        const rows = await listScadenzarioRows(company.id, {
          mode: 'all', periodPreset: 'next_30',
          statuses: ['pending', 'overdue', 'partial'],
          sortBy: 'due_date', sortDir: 'asc',
        })
        if (mounted) setUpcomingRows(rows.slice(0, 5))
      } catch { if (mounted) setUpcomingRows([]) }
    }
    loadUpcoming()
    return () => { mounted = false }
  }, [company?.id])

  // ─── Load monthly revenue/cost data + KPIs ───
  useEffect(() => {
    let mounted = true
    async function loadFinancialData() {
      if (!company?.id) {
        if (mounted) { setMonthlyData([]); setChartLoading(false) }
        return
      }
      setChartLoading(true)
      try {
        // Fetch all invoices for this company (direction + date + amount)
        const { data: invoices, error } = await supabase
          .from('invoices')
          .select('direction, date, total_amount, reconciliation_status')
          .eq('company_id', company.id)
          .not('date', 'is', null)
          .order('date', { ascending: true })

        if (error) throw error

        // Aggregate by month
        const monthMap = new Map<string, { ricavi: number; costi: number }>()
        let totalInvoices = 0
        let unreconciledCount = 0

        for (const inv of invoices || []) {
          totalInvoices++
          if (inv.reconciliation_status === 'unmatched') unreconciledCount++

          const mk = toMonthKey(inv.date)
          const existing = monthMap.get(mk) || { ricavi: 0, costi: 0 }
          const amt = Number(inv.total_amount) || 0

          if (inv.direction === 'out') {
            existing.ricavi += amt
          } else {
            existing.costi += amt
          }
          monthMap.set(mk, existing)
        }

        // Convert to sorted array
        const sorted = Array.from(monthMap.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([mk, vals]) => ({
            month: mk,
            monthLabel: toMonthLabel(mk + '-01'),
            ricavi: Math.round(vals.ricavi * 100) / 100,
            costi: Math.round(vals.costi * 100) / 100,
            ebitda: Math.round((vals.ricavi - vals.costi) * 100) / 100,
          }))

        // Count bank transactions
        const { count: bankCount } = await supabase
          .from('bank_transactions')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', company.id)

        if (mounted) {
          setMonthlyData(sorted)
          setKpiData({
            invoiceCount: totalInvoices,
            bankTxCount: bankCount || 0,
            unreconciled: unreconciledCount,
            upcomingDue: upcomingRows.length,
          })
        }
      } catch (err) {
        console.error('Dashboard financial data error:', err)
      } finally {
        if (mounted) setChartLoading(false)
      }
    }
    loadFinancialData()
    return () => { mounted = false }
  }, [company?.id, upcomingRows.length])

  // ─── Computed YTD totals ───
  const ytd = useMemo(() => {
    const now = new Date()
    const yearPrefix = String(now.getFullYear())
    const thisYear = monthlyData.filter(d => d.month.startsWith(yearPrefix))
    const totalRicavi = thisYear.reduce((s, d) => s + d.ricavi, 0)
    const totalCosti = thisYear.reduce((s, d) => s + d.costi, 0)
    return {
      ricavi: totalRicavi,
      costi: totalCosti,
      ebitda: totalRicavi - totalCosti,
      marginPct: totalRicavi > 0 ? ((totalRicavi - totalCosti) / totalRicavi) * 100 : 0,
    }
  }, [monthlyData])

  // ─── Computed P&L section totals ───
  const plTotals = useMemo<PlSectionTotals>(() => {
    const t: PlSectionTotals = {
      revenue: 0, cost_production: 0, cost_personnel: 0,
      depreciation: 0, other_costs: 0, financial: 0, extraordinary: 0,
    }
    for (const r of plRows) {
      if (r.section in t) t[r.section] += r.total
    }
    return t
  }, [plRows])

  const plEbitda = plTotals.revenue - plTotals.cost_production - plTotals.cost_personnel - plTotals.other_costs
  const plEbit = plEbitda - plTotals.depreciation
  const plEbt = plEbit - plTotals.financial - plTotals.extraordinary

  // Group plRows by section for expandable detail
  const plBySection = useMemo(() => {
    const map = new Map<CoaSection, PlAccountRow[]>()
    for (const r of plRows) {
      const arr = map.get(r.section) || []
      arr.push(r)
      map.set(r.section, arr)
    }
    return map
  }, [plRows])

  // Dynamic KPIs with real data
  const kpis = [
    { label: 'Fatture importate', value: String(kpiData.invoiceCount), icon: FileText, color: 'text-blue-600', bg: 'bg-blue-50' },
    { label: 'Movimenti banca', value: String(kpiData.bankTxCount), icon: Landmark, color: 'text-emerald-600', bg: 'bg-emerald-50' },
    { label: 'Da riconciliare', value: String(kpiData.unreconciled), icon: Link2, color: 'text-amber-600', bg: 'bg-amber-50' },
    { label: 'Scadenze prossime', value: String(upcomingRows.length), icon: CalendarClock, color: 'text-red-600', bg: 'bg-red-50' },
  ]

  return (
    <div className="p-6 space-y-6 max-w-[1400px]">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Dashboard</h1>
        <p className="text-slate-500 text-sm mt-1">Panoramica della situazione finanziaria</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {kpis.map(k => (
          <Card key={k.label} className="border-slate-200">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-slate-500 uppercase tracking-wide">{k.label}</p>
                  <p className="text-2xl font-bold mt-1 text-slate-900">{k.value}</p>
                </div>
                <div className={`rounded-xl p-2.5 ${k.bg}`}>
                  <k.icon className={`h-5 w-5 ${k.color}`} />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ═══ EBITDA Chart Section ═══ */}
      <Card className="border-slate-200 overflow-hidden">
        <CardHeader className="bg-slate-50/50 border-b border-slate-100 pb-4">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-indigo-600" />
              <span className="text-slate-800">Riepilogo Finanziario Mensile</span>
            </CardTitle>
            {monthlyData.length > 0 && (
              <span className="text-[10px] text-slate-400">
                {monthlyData[0]?.monthLabel} — {monthlyData[monthlyData.length - 1]?.monthLabel}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-5 pb-2 px-2 sm:px-4">
          {/* YTD Summary Strip */}
          {!chartLoading && monthlyData.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6 px-2">
              <div className="rounded-lg bg-emerald-50 border border-emerald-100 px-4 py-3">
                <p className="text-[10px] text-emerald-600 uppercase font-semibold tracking-wider">Ricavi YTD</p>
                <p className="text-lg font-bold text-emerald-800 mt-0.5">{fmtEur(ytd.ricavi)}</p>
              </div>
              <div className="rounded-lg bg-rose-50 border border-rose-100 px-4 py-3">
                <p className="text-[10px] text-rose-600 uppercase font-semibold tracking-wider">Costi YTD</p>
                <p className="text-lg font-bold text-rose-800 mt-0.5">{fmtEur(ytd.costi)}</p>
              </div>
              <div className={`rounded-lg border px-4 py-3 ${ytd.ebitda >= 0 ? 'bg-indigo-50 border-indigo-100' : 'bg-amber-50 border-amber-200'}`}>
                <p className={`text-[10px] uppercase font-semibold tracking-wider ${ytd.ebitda >= 0 ? 'text-indigo-600' : 'text-amber-600'}`}>EBITDA YTD</p>
                <p className={`text-lg font-bold mt-0.5 ${ytd.ebitda >= 0 ? 'text-indigo-800' : 'text-amber-800'}`}>{fmtEur(ytd.ebitda)}</p>
              </div>
              <div className="rounded-lg bg-slate-50 border border-slate-200 px-4 py-3">
                <p className="text-[10px] text-slate-500 uppercase font-semibold tracking-wider">Margine %</p>
                <p className={`text-lg font-bold mt-0.5 ${ytd.marginPct >= 0 ? 'text-slate-800' : 'text-red-700'}`}>
                  {ytd.marginPct.toFixed(1)}%
                </p>
              </div>
            </div>
          )}

          {/* Chart */}
          {chartLoading ? (
            <div className="flex items-center justify-center h-72 text-slate-400 text-sm">
              <div className="flex flex-col items-center gap-2">
                <div className="w-6 h-6 border-2 border-indigo-300 border-t-transparent rounded-full animate-spin" />
                <span>Caricamento dati...</span>
              </div>
            </div>
          ) : monthlyData.length === 0 ? (
            <div className="flex items-center justify-center h-72 text-slate-400 text-sm">
              <div className="text-center space-y-2">
                <BarChart3 className="h-10 w-10 text-slate-300 mx-auto" />
                <p>Importa fatture per visualizzare il riepilogo finanziario</p>
              </div>
            </div>
          ) : (
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={monthlyData} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis
                    dataKey="monthLabel"
                    tick={{ fontSize: 11, fill: '#94a3b8' }}
                    tickLine={false}
                    axisLine={{ stroke: '#e2e8f0' }}
                  />
                  <YAxis
                    width={68}
                    tick={{ fontSize: 11, fill: '#94a3b8' }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={formatCompactEur}
                  />
                  <Tooltip content={<EbitdaTooltip />} />
                  <Legend
                    iconType="square"
                    iconSize={10}
                    wrapperStyle={{ fontSize: 12, paddingTop: 12 }}
                  />
                  <Bar
                    dataKey="ricavi"
                    name="Ricavi"
                    fill="#059669"
                    radius={[3, 3, 0, 0]}
                    barSize={monthlyData.length > 18 ? 12 : monthlyData.length > 12 ? 16 : 24}
                  />
                  <Bar
                    dataKey="costi"
                    name="Costi"
                    fill="#e11d48"
                    radius={[3, 3, 0, 0]}
                    barSize={monthlyData.length > 18 ? 12 : monthlyData.length > 12 ? 16 : 24}
                  />
                  <Line
                    type="monotone"
                    dataKey="ebitda"
                    name="EBITDA"
                    stroke="#6366f1"
                    strokeWidth={2.5}
                    dot={{ fill: '#6366f1', strokeWidth: 0, r: 4 }}
                    activeDot={{ r: 6, stroke: '#6366f1', strokeWidth: 2, fill: '#fff' }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ═══ Conto Economico Summary Table ═══ */}
      <Card className="border-slate-200 overflow-hidden">
        <CardHeader className="bg-slate-50/50 border-b border-slate-100 pb-4">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-emerald-600" />
              <span className="text-slate-800">Conto Economico — {new Date().getFullYear()}</span>
            </CardTitle>
            {plRows.length > 0 && (
              <span className="text-[10px] text-slate-400">
                {plRows.length} voci classificate
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {plLoading ? (
            <div className="flex items-center justify-center h-40 text-slate-400 text-sm">
              <div className="flex flex-col items-center gap-2">
                <div className="w-5 h-5 border-2 border-emerald-300 border-t-transparent rounded-full animate-spin" />
                <span>Caricamento piano dei conti...</span>
              </div>
            </div>
          ) : plRows.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-slate-400 text-sm">
              <div className="text-center space-y-1">
                <TrendingUp className="h-8 w-8 text-slate-300 mx-auto" />
                <p>Classifica le righe fattura per popolare il conto economico</p>
              </div>
            </div>
          ) : (
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-slate-50/80">
                  <th className="text-left px-4 py-2 font-semibold text-slate-500 w-[60px]">Codice</th>
                  <th className="text-left px-4 py-2 font-semibold text-slate-500">Voce</th>
                  <th className="text-right px-4 py-2 font-semibold text-slate-500 w-[140px]">Importo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {/* ── Above EBITDA sections ── */}
                {PL_SECTION_ORDER.map(sec => {
                  const rows = plBySection.get(sec.key) || []
                  const sectionTotal = plTotals[sec.key]
                  if (rows.length === 0 && sectionTotal === 0) return null
                  return (
                    <PlSectionBlock
                      key={sec.key}
                      label={sec.label}
                      rows={rows}
                      total={sectionTotal}
                      isRevenue={sec.key === 'revenue'}
                    />
                  )
                })}

                {/* ── EBITDA subtotal ── */}
                <tr className="bg-indigo-50/70 border-t-2 border-indigo-200">
                  <td colSpan={2} className="px-4 py-2.5 font-bold text-indigo-900 text-[13px]">
                    EBITDA
                  </td>
                  <td className={`text-right px-4 py-2.5 font-bold text-[13px] ${plEbitda >= 0 ? 'text-indigo-900' : 'text-red-700'}`}>
                    {fmtEur(plEbitda)}
                  </td>
                </tr>

                {/* ── Below EBITDA sections ── */}
                {PL_BELOW_EBITDA.map(sec => {
                  const rows = plBySection.get(sec.key) || []
                  const sectionTotal = plTotals[sec.key]
                  if (rows.length === 0 && sectionTotal === 0) return null
                  return (
                    <PlSectionBlock
                      key={sec.key}
                      label={sec.label}
                      rows={rows}
                      total={sectionTotal}
                      isRevenue={false}
                    />
                  )
                })}

                {/* ── EBIT subtotal ── */}
                <tr className="bg-slate-100/70 border-t-2 border-slate-300">
                  <td colSpan={2} className="px-4 py-2 font-bold text-slate-800 text-[12px]">
                    EBIT (Risultato Operativo)
                  </td>
                  <td className={`text-right px-4 py-2 font-bold text-[12px] ${plEbit >= 0 ? 'text-slate-800' : 'text-red-700'}`}>
                    {fmtEur(plEbit)}
                  </td>
                </tr>

                {/* ── EBT subtotal ── */}
                <tr className="bg-slate-50/70">
                  <td colSpan={2} className="px-4 py-2 font-semibold text-slate-600 text-[12px]">
                    EBT (Risultato ante imposte)
                  </td>
                  <td className={`text-right px-4 py-2 font-semibold text-[12px] ${plEbt >= 0 ? 'text-slate-600' : 'text-red-600'}`}>
                    {fmtEur(plEbt)}
                  </td>
                </tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* IVA Summary */}
      <Card className="border-slate-200">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Receipt className="h-4 w-4 text-amber-600" />
            IVA Stimata
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!vatSummary ? (
            <p className="text-sm text-slate-500">Configura la sezione IVA per vedere saldo e prossima scadenza.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div className="rounded-lg border bg-emerald-50 border-emerald-200 p-3">
                <p className="text-[10px] text-emerald-700 uppercase font-semibold tracking-wider">IVA debito</p>
                <p className="text-lg font-bold text-emerald-800">{fmtEur(vatSummary.period.vat_debit)}</p>
              </div>
              <div className="rounded-lg border bg-blue-50 border-blue-200 p-3">
                <p className="text-[10px] text-blue-700 uppercase font-semibold tracking-wider">IVA credito</p>
                <p className="text-lg font-bold text-blue-800">{fmtEur(vatSummary.period.vat_credit)}</p>
              </div>
              <div className="rounded-lg border bg-amber-50 border-amber-200 p-3">
                <p className="text-[10px] text-amber-700 uppercase font-semibold tracking-wider">Saldo stimato</p>
                <p className="text-lg font-bold text-amber-800">{fmtEur(vatSummary.period.amount_due > 0 ? vatSummary.period.amount_due : vatSummary.period.amount_credit_carry)}</p>
              </div>
              <div className="rounded-lg border bg-slate-50 border-slate-200 p-3">
                <p className="text-[10px] text-slate-600 uppercase font-semibold tracking-wider">Scadenza</p>
                <p className="text-sm font-semibold text-slate-900">{formatVatPeriodLabel(vatSummary.period)}</p>
                <p className="text-sm text-slate-600 mt-1">{fmtDate(vatSummary.period.due_date)}</p>
                <p className="text-[10px] text-slate-400 mt-1">{vatSummary.days_to_due} giorni</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Upcoming Deadlines */}
      <Card className="border-slate-200">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-red-600" />
            Prossime scadenze
          </CardTitle>
        </CardHeader>
        <CardContent>
          {upcomingRows.length === 0 ? (
            <p className="text-sm text-slate-500">Nessuna scadenza nei prossimi 30 giorni.</p>
          ) : (
            <div className="space-y-2">
              {upcomingRows.map((row) => (
                <button
                  key={`${row.kind}-${row.id}`}
                  onClick={() => navigate(row.reference_link)}
                  className="w-full text-left border border-slate-200 rounded-lg px-3 py-2 hover:bg-slate-50 transition-colors"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-slate-800">{row.reference}</p>
                      <p className="text-xs text-slate-500">{row.counterparty_name} · {fmtDate(row.due_date)}</p>
                    </div>
                    <p className={`text-sm font-semibold ${row.type === 'incasso' ? 'text-emerald-700' : 'text-red-700'}`}>
                      {fmtEur(row.remaining_amount > 0 ? row.remaining_amount : row.amount)}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Onboarding Steps */}
      <Card className="border-slate-200">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-amber-600" />
            Prossimi passi
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[
              { step: '1', text: 'Importa le fatture XML/P7M dalla sezione Fatture', done: kpiData.invoiceCount > 0 },
              { step: '2', text: "Carica l'estratto conto PDF dalla sezione Banca", done: kpiData.bankTxCount > 0 },
              { step: '3', text: 'Riconcilia automaticamente fatture e movimenti', done: kpiData.unreconciled === 0 && kpiData.invoiceCount > 0 },
              { step: '4', text: 'Monitora le scadenze di pagamento e IVA', done: false },
            ].map(s => (
              <div key={s.step} className="flex items-center gap-3">
                <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  s.done ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
                }`}>{s.done ? '\u2713' : s.step}</div>
                <span className={`text-sm ${s.done ? 'text-slate-500 line-through' : 'text-slate-800'}`}>{s.text}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
