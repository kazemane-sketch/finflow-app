import { useEffect, useState } from 'react'
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
} from 'lucide-react'
import { useCompany } from '@/hooks/useCompany'
import { getVatCurrentSummary, formatVatPeriodLabel, type VatCurrentSummary } from '@/lib/vat'
import { listScadenzarioRows, touchOverdueInstallments, type ScadenzarioRow } from '@/lib/scadenzario'

const kpis = [
  { label: 'Fatture importate', value: '0', icon: FileText, color: 'text-blue-600', bg: 'bg-blue-50' },
  { label: 'Movimenti banca', value: '0', icon: Landmark, color: 'text-emerald-600', bg: 'bg-emerald-50' },
  { label: 'Da riconciliare', value: '0', icon: Link2, color: 'text-amber-600', bg: 'bg-amber-50' },
  { label: 'Scadenze prossime', value: '0', icon: CalendarClock, color: 'text-red-600', bg: 'bg-red-50' },
]

export default function DashboardPage() {
  const { company } = useCompany()
  const navigate = useNavigate()
  const [vatSummary, setVatSummary] = useState<VatCurrentSummary | null>(null)
  const [upcomingRows, setUpcomingRows] = useState<ScadenzarioRow[]>([])

  useEffect(() => {
    let mounted = true
    async function loadVatSummary() {
      if (!company?.id) {
        if (mounted) setVatSummary(null)
        return
      }
      try {
        const data = await getVatCurrentSummary(company.id)
        if (mounted) setVatSummary(data)
      } catch {
        if (mounted) setVatSummary(null)
      }
    }
    loadVatSummary()
    return () => {
      mounted = false
    }
  }, [company?.id])

  useEffect(() => {
    let mounted = true

    async function loadUpcoming() {
      if (!company?.id) {
        if (mounted) setUpcomingRows([])
        return
      }

      try {
        await touchOverdueInstallments(company.id)
        const rows = await listScadenzarioRows(company.id, {
          mode: 'all',
          periodPreset: 'next_30',
          statuses: ['pending', 'overdue', 'partial'],
          sortBy: 'due_date',
          sortDir: 'asc',
        })
        if (mounted) setUpcomingRows(rows.slice(0, 5))
      } catch {
        if (mounted) setUpcomingRows([])
      }
    }

    loadUpcoming()
    return () => {
      mounted = false
    }
  }, [company?.id])

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">Panoramica della situazione finanziaria</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {kpis.map(k => (
          <Card key={k.label}>
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{k.label}</p>
                  <p className="text-2xl font-bold mt-1">{k.value}</p>
                </div>
                <div className={`rounded-lg p-2.5 ${k.bg}`}>
                  <k.icon className={`h-5 w-5 ${k.color}`} />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Receipt className="h-4 w-4 text-amber-600" />
            IVA Stimata
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!vatSummary ? (
            <p className="text-sm text-muted-foreground">Configura la sezione IVA per vedere saldo e prossima scadenza.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div className="rounded-lg border bg-emerald-50 border-emerald-200 p-3">
                <p className="text-xs text-emerald-700 uppercase">IVA debito</p>
                <p className="text-lg font-bold text-emerald-800">{fmtEur(vatSummary.period.vat_debit)}</p>
              </div>
              <div className="rounded-lg border bg-blue-50 border-blue-200 p-3">
                <p className="text-xs text-blue-700 uppercase">IVA credito</p>
                <p className="text-lg font-bold text-blue-800">{fmtEur(vatSummary.period.vat_credit)}</p>
              </div>
              <div className="rounded-lg border bg-amber-50 border-amber-200 p-3">
                <p className="text-xs text-amber-700 uppercase">Saldo stimato</p>
                <p className="text-lg font-bold text-amber-800">{fmtEur(vatSummary.period.amount_due > 0 ? vatSummary.period.amount_due : vatSummary.period.amount_credit_carry)}</p>
              </div>
              <div className="rounded-lg border bg-gray-50 border-gray-200 p-3">
                <p className="text-xs text-gray-700 uppercase">Scadenza</p>
                <p className="text-sm font-semibold text-gray-900">{formatVatPeriodLabel(vatSummary.period)}</p>
                <p className="text-sm text-gray-600 mt-1">{fmtDate(vatSummary.period.due_date)}</p>
                <p className="text-xs text-gray-500 mt-1">{vatSummary.days_to_due} giorni</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-red-600" />
            Prossime scadenze
          </CardTitle>
        </CardHeader>
        <CardContent>
          {upcomingRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nessuna scadenza nei prossimi 30 giorni.</p>
          ) : (
            <div className="space-y-2">
              {upcomingRows.map((row) => (
                <button
                  key={`${row.kind}-${row.id}`}
                  onClick={() => navigate(row.reference_link)}
                  className="w-full text-left border rounded-lg px-3 py-2 hover:bg-gray-50"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">{row.reference}</p>
                      <p className="text-xs text-muted-foreground">{row.counterparty_name} · {fmtDate(row.due_date)}</p>
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-emerald-600" />
              Entrate recenti
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
              Importa fatture per visualizzare i dati
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingDown className="h-4 w-4 text-red-600" />
              Uscite recenti
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
              Importa l'estratto conto per visualizzare i dati
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-amber-600" />
            Prossimi passi
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[
              { step: '1', text: 'Importa le fatture XML/P7M dalla sezione Fatture', done: false },
              { step: '2', text: 'Carica l\'estratto conto PDF dalla sezione Banca', done: false },
              { step: '3', text: 'Riconcilia automaticamente fatture e movimenti', done: false },
              { step: '4', text: 'Monitora le scadenze di pagamento e IVA', done: false },
            ].map(s => (
              <div key={s.step} className="flex items-center gap-3">
                <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  s.done ? 'bg-emerald-100 text-emerald-700' : 'bg-muted text-muted-foreground'
                }`}>{s.step}</div>
                <span className="text-sm">{s.text}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
