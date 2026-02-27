// src/pages/ImpostazioniPage.tsx
import { useState, useEffect } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/hooks/useAuth'
import { useCompany } from '@/hooks/useCompany'
import { Settings, Building2, Key, CheckCircle, Eye, EyeOff } from 'lucide-react'
import { getClaudeApiKey, setClaudeApiKey } from '@/lib/bankParser'

export default function ImpostazioniPage() {
  const { user } = useAuth()
  const { company } = useCompany()

  // API Key state
  const [apiKey, setApiKey] = useState('')
  const [apiKeySaved, setApiKeySaved] = useState(false)
  const [showKey, setShowKey] = useState(false)

  useEffect(() => {
    const stored = getClaudeApiKey()
    if (stored) setApiKey(stored)
  }, [])

  const handleSaveApiKey = () => {
    setClaudeApiKey(apiKey.trim())
    setApiKeySaved(true)
    setTimeout(() => setApiKeySaved(false), 2500)
  }

  const handleClearApiKey = () => {
    setApiKey('')
    setClaudeApiKey('')
  }

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Impostazioni</h1>
        <p className="text-muted-foreground text-sm mt-1">Configura il tuo profilo e le impostazioni aziendali</p>
      </div>

      {/* Account */}
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

      {/* Azienda */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="h-4 w-4" /> Azienda
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {company ? (
            <>
              <div>
                <Label className="text-xs text-muted-foreground">Denominazione</Label>
                <p className="text-sm font-medium mt-1">{company.name}</p>
              </div>
              {company.vat_number && (
                <div>
                  <Label className="text-xs text-muted-foreground">Partita IVA</Label>
                  <p className="text-sm font-medium mt-1">{company.vat_number}</p>
                </div>
              )}
              {company.fiscal_code && (
                <div>
                  <Label className="text-xs text-muted-foreground">Codice Fiscale</Label>
                  <p className="text-sm font-medium mt-1">{company.fiscal_code}</p>
                </div>
              )}
              {company.city && (
                <div>
                  <Label className="text-xs text-muted-foreground">Città</Label>
                  <p className="text-sm font-medium mt-1">{[company.city, company.province ? `(${company.province})` : ''].filter(Boolean).join(' ')}</p>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              La configurazione aziendale verrà completata nelle prossime fasi.
              I dati dell'azienda saranno estratti automaticamente dalle fatture importate.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Claude API Key */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Key className="h-4 w-4" /> Chiave API Claude (Anthropic)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            La chiave API Claude è necessaria per l'import degli estratti conto PDF e la ricerca AI nelle fatture.
            Ottienila su <a href="https://console.anthropic.com" target="_blank" rel="noopener noreferrer" className="text-sky-600 underline">console.anthropic.com</a>.
          </p>

          <div className="space-y-2">
            <Label htmlFor="apikey" className="text-xs">Chiave API</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  id="apikey"
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={e => { setApiKey(e.target.value); setApiKeySaved(false) }}
                  placeholder="sk-ant-api03-..."
                  className="pr-9 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(v => !v)}
                  className="absolute right-2.5 top-2 text-gray-400 hover:text-gray-600"
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <Button onClick={handleSaveApiKey} disabled={!apiKey.trim() || apiKeySaved} size="sm">
                {apiKeySaved ? (
                  <><CheckCircle className="h-3.5 w-3.5 mr-1.5 text-emerald-400" />Salvata</>
                ) : 'Salva'}
              </Button>
              {apiKey && (
                <Button variant="outline" size="sm" onClick={handleClearApiKey}>
                  Rimuovi
                </Button>
              )}
            </div>
          </div>

          {getClaudeApiKey() && (
            <div className="flex items-center gap-2 text-xs text-emerald-700">
              <CheckCircle className="h-3.5 w-3.5" />
              Chiave API configurata — import PDF abilitato
            </div>
          )}

          <div className="text-xs text-muted-foreground bg-gray-50 rounded-lg p-3">
            <p className="font-medium mb-1">🔒 Sicurezza</p>
            <p>La chiave viene salvata solo nel browser locale (localStorage) e non viene mai inviata a server FinFlow.
               Viene usata direttamente per chiamare l'API Anthropic durante l'import.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
