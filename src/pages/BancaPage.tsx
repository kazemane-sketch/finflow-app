import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Upload, Landmark, Construction } from 'lucide-react'

export default function BancaPage() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Banca</h1>
        <p className="text-muted-foreground text-sm mt-1">Importa e gestisci movimenti bancari</p>
      </div>

      <Card>
        <CardContent className="p-8">
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 mb-4">
              <Landmark className="h-8 w-8 text-primary" />
            </div>
            <h3 className="text-lg font-semibold mb-2">Import Estratto Conto</h3>
            <p className="text-sm text-muted-foreground mb-4 max-w-md mx-auto">
              Carica il PDF dell'estratto conto MPS (o altra banca) per importare automaticamente i movimenti.
            </p>
            <div className="flex items-center justify-center gap-2">
              <Construction className="h-4 w-4 text-amber-500" />
              <span className="text-sm text-amber-600 font-medium">In sviluppo — Prossima fase</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Conti Bancari</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground text-sm">
            Nessun conto bancario configurato.
            <br />
            Il conto verrà creato automaticamente al primo import.
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
