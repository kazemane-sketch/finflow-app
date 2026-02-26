import { Card, CardContent } from '@/components/ui/card'
import { CalendarClock, Construction } from 'lucide-react'

export default function ScadenzarioPage() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Scadenzario</h1>
        <p className="text-muted-foreground text-sm mt-1">Monitora le scadenze di pagamento</p>
      </div>
      <Card>
        <CardContent className="p-8">
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 mb-4">
              <CalendarClock className="h-8 w-8 text-primary" />
            </div>
            <h3 className="text-lg font-semibold mb-2">Scadenze Pagamento</h3>
            <p className="text-sm text-muted-foreground mb-4 max-w-md mx-auto">
              Le scadenze verranno estratte automaticamente dalle fatture importate,
              con vista calendario e avvisi per i pagamenti in scadenza.
            </p>
            <div className="flex items-center justify-center gap-2">
              <Construction className="h-4 w-4 text-amber-500" />
              <span className="text-sm text-amber-600 font-medium">Richiede import fatture</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
