import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { fmtEur } from '@/lib/utils'
import {
  FileText,
  Landmark,
  Link2,
  CalendarClock,
  TrendingUp,
  TrendingDown,
  AlertCircle,
} from 'lucide-react'

const kpis = [
  { label: 'Fatture importate', value: '0', icon: FileText, color: 'text-blue-600', bg: 'bg-blue-50' },
  { label: 'Movimenti banca', value: '0', icon: Landmark, color: 'text-emerald-600', bg: 'bg-emerald-50' },
  { label: 'Da riconciliare', value: '0', icon: Link2, color: 'text-amber-600', bg: 'bg-amber-50' },
  { label: 'Scadenze prossime', value: '0', icon: CalendarClock, color: 'text-red-600', bg: 'bg-red-50' },
]

export default function DashboardPage() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">Panoramica della situazione finanziaria</p>
      </div>

      {/* KPI Grid */}
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

      {/* Placeholder sections */}
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
              { step: '4', text: 'Monitora le scadenze di pagamento', done: false },
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
