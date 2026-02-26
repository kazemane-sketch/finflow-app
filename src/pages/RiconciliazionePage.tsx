import { Card, CardContent } from '@/components/ui/card'
import { Link2, Construction } from 'lucide-react'

export default function RiconciliazionePage() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Riconciliazione</h1>
        <p className="text-muted-foreground text-sm mt-1">Abbina fatture e movimenti bancari</p>
      </div>
      <Card>
        <CardContent className="p-8">
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 mb-4">
              <Link2 className="h-8 w-8 text-primary" />
            </div>
            <h3 className="text-lg font-semibold mb-2">Riconciliazione Automatica</h3>
            <p className="text-sm text-muted-foreground mb-4 max-w-md mx-auto">
              Dopo aver importato fatture e movimenti bancari, FinFlow abbinerà automaticamente
              i pagamenti alle fatture usando importi, date e nomi fornitori.
            </p>
            <div className="flex items-center justify-center gap-2">
              <Construction className="h-4 w-4 text-amber-500" />
              <span className="text-sm text-amber-600 font-medium">Richiede import fatture + banca</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
