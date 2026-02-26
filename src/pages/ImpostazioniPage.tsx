import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/hooks/useAuth'
import { Settings, Building2 } from 'lucide-react'

export default function ImpostazioniPage() {
  const { user } = useAuth()

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Impostazioni</h1>
        <p className="text-muted-foreground text-sm mt-1">Configura il tuo profilo e le impostazioni aziendali</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Settings className="h-4 w-4" /> Account
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label className="text-xs text-muted-foreground">Email</Label>
            <p className="text-sm font-medium mt-1">{user?.email}</p>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">ID Utente</Label>
            <p className="text-xs font-mono text-muted-foreground mt-1">{user?.id}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="h-4 w-4" /> Azienda
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            La configurazione aziendale verrà completata nelle prossime fasi.
            I dati dell'azienda saranno estratti automaticamente dalle fatture importate.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
