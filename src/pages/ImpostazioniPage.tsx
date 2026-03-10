// src/pages/ImpostazioniPage.tsx
import { useState, useEffect, useCallback } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/hooks/useAuth'
import { useCompany } from '@/hooks/useCompany'
import { Settings, Building2, Landmark, Pencil, Trash2, Plus, X, AlertTriangle, CheckCircle, Tag, FolderKanban, BookOpen, Brain, Loader2 } from 'lucide-react'
import { supabase } from '@/integrations/supabase/client'
import { saveOpeningBalance } from '@/lib/bankParser'
import CategoriesTab from '@/components/settings/CategoriesTab'
import ProjectsTab from '@/components/settings/ProjectsTab'
import ChartOfAccountsTab from '@/components/settings/ChartOfAccountsTab'
import { triggerFullBrainBackfill, type BrainBackfillResult } from '@/lib/companyMemoryService'

type SettingsTab = 'generale' | 'categorie' | 'progetti' | 'piano-conti' | 'istruzioni-ai'

const TABS: { key: SettingsTab; label: string; icon: typeof Settings }[] = [
  { key: 'generale', label: 'Generale', icon: Settings },
  { key: 'categorie', label: 'Categorie', icon: Tag },
  { key: 'progetti', label: 'Centri di Costo', icon: FolderKanban },
  { key: 'piano-conti', label: 'Piano dei Conti', icon: BookOpen },
  { key: 'istruzioni-ai', label: 'Istruzioni AI', icon: Brain },
]

// ============================================================
// BANK ACCOUNT FORM MODAL
// ============================================================
function BankAccountModal({
  account,
  companyId,
  onSave,
  onClose,
}: {
  account?: any
  companyId: string
  onSave: () => void
  onClose: () => void
}) {
  const [form, setForm] = useState({
    name: account?.name || '',
    iban: account?.iban || '',
    bank_name: account?.bank_name || '',

  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleSave = async () => {
    if (!form.name.trim()) { setError('Il nome del conto è obbligatorio'); return }
    setSaving(true)
    setError('')
    try {
      if (account?.id) {
        const { error: err } = await supabase
          .from('bank_accounts')
          .update({
            name: form.name.trim(),
            iban: form.iban.trim() || null,
            bank_name: form.bank_name.trim() || null,
          })
          .eq('id', account.id)
        if (err) throw err
      } else {
        const { error: err } = await supabase
          .from('bank_accounts')
          .insert({
            company_id: companyId,
            name: form.name.trim(),
            iban: form.iban.trim() || null,
            bank_name: form.bank_name.trim() || null,
          })
        if (err) throw err
      }
      onSave()
    } catch (e: any) {
      setError(e.message)
    }
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full mx-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-900">{account ? 'Modifica conto' : 'Nuovo conto bancario'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Nome conto *</Label>
            <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Es. Conto principale MPS" className="mt-1" />
          </div>
          <div>
            <Label className="text-xs">IBAN</Label>
            <Input value={form.iban} onChange={e => setForm(f => ({ ...f, iban: e.target.value }))}
              placeholder="IT77A010..." className="mt-1 font-mono text-sm" maxLength={34} />
          </div>
          <div>
            <Label className="text-xs">Banca</Label>
            <Input value={form.bank_name} onChange={e => setForm(f => ({ ...f, bank_name: e.target.value }))}
              placeholder="Es. Monte dei Paschi di Siena" className="mt-1" />
          </div>

          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
        <div className="flex gap-2 justify-end mt-5">
          <Button variant="outline" onClick={onClose}>Annulla</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Salvataggio...' : account ? 'Aggiorna' : 'Aggiungi'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// DELETE CONFIRM
// ============================================================
function DeleteBankModal({ name, onConfirm, onCancel }: {
  name: string; onConfirm: () => void; onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100">
            <AlertTriangle className="h-5 w-5 text-red-600" />
          </div>
          <div>
            <p className="font-semibold text-gray-900">Elimina conto</p>
            <p className="text-sm text-gray-500">Eliminare <strong>{name}</strong>?</p>
          </div>
        </div>
        <p className="text-sm text-red-600 mb-5">⚠️ Tutti i movimenti collegati verranno eliminati. Azione irreversibile.</p>
        <div className="flex gap-3 justify-end">
          <Button variant="outline" onClick={onCancel}>Annulla</Button>
          <Button variant="destructive" onClick={onConfirm}>
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />Elimina
          </Button>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// INSTRUCTIONS TAB
// ============================================================
const SCOPE_LABELS: Record<string, string> = {
  general: 'Generale',
  counterparty: 'Controparte',
  category: 'Categoria',
  classification: 'Classificazione',
  reconciliation: 'Riconciliazione',
}

const SCOPE_COLORS: Record<string, string> = {
  general: 'bg-gray-100 text-gray-700',
  counterparty: 'bg-blue-100 text-blue-700',
  category: 'bg-green-100 text-green-700',
  classification: 'bg-purple-100 text-purple-700',
  reconciliation: 'bg-amber-100 text-amber-700',
}

function InstructionsTab({ companyId }: { companyId: string }) {
  const [instructions, setInstructions] = useState<Array<{
    id: string; scope: string; scope_ref: string | null; instruction: string;
    source: string; created_at: string; counterparty_name?: string
  }>>([])
  const [loading, setLoading] = useState(true)
  const [newInstruction, setNewInstruction] = useState('')
  const [newScope, setNewScope] = useState('general')

  const loadInstructions = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await supabase
        .from('user_instructions')
        .select('id, scope, scope_ref, instruction, source, created_at')
        .eq('company_id', companyId)
        .eq('active', true)
        .order('scope')
        .order('created_at', { ascending: true })

      // Resolve counterparty names for scope_ref
      const items = data || []
      const cpRefs = items.filter(i => i.scope === 'counterparty' && i.scope_ref).map(i => i.scope_ref!)
      let cpNames: Record<string, string> = {}
      if (cpRefs.length > 0) {
        const { data: cps } = await supabase
          .from('counterparties')
          .select('id, name')
          .in('id', cpRefs)
        if (cps) cpNames = Object.fromEntries(cps.map(c => [c.id, c.name]))
      }

      setInstructions(items.map(i => ({
        ...i,
        counterparty_name: i.scope_ref ? cpNames[i.scope_ref] : undefined,
      })))
    } catch { /* ignore */ }
    setLoading(false)
  }, [companyId])

  useEffect(() => { loadInstructions() }, [loadInstructions])

  const addInstruction = async () => {
    if (!newInstruction.trim()) return
    await supabase.from('user_instructions').insert({
      company_id: companyId,
      scope: newScope,
      instruction: newInstruction.trim(),
      source: 'manual',
    })
    setNewInstruction('')
    loadInstructions()
  }

  const removeInstruction = async (id: string) => {
    await supabase.from('user_instructions').update({ active: false }).eq('id', id)
    loadInstructions()
  }

  // Group by scope
  const grouped = instructions.reduce<Record<string, typeof instructions>>((acc, inst) => {
    const key = inst.scope
    if (!acc[key]) acc[key] = []
    acc[key].push(inst)
    return acc
  }, {})

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Brain className="h-4 w-4 text-purple-600" />
          Istruzioni AI
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-gray-500">
          Le istruzioni vengono applicate automaticamente a tutte le classificazioni AI e sessioni chat.
          Puoi salvarle anche dalla chat AI dicendo cose come "ricorda che le fatture X sono sempre Y".
        </p>

        {/* Add new instruction */}
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <Label className="text-xs">Nuova istruzione</Label>
            <Input
              value={newInstruction}
              onChange={(e) => setNewInstruction(e.target.value)}
              placeholder="Es: le fatture CREDEMLEASING sono sempre leasing veicoli"
              className="mt-1"
              onKeyDown={(e) => e.key === 'Enter' && addInstruction()}
            />
          </div>
          <select
            value={newScope}
            onChange={(e) => setNewScope(e.target.value)}
            className="h-9 border rounded-md px-2 text-xs"
          >
            <option value="general">Generale</option>
            <option value="classification">Classificazione</option>
            <option value="reconciliation">Riconciliazione</option>
          </select>
          <Button size="sm" onClick={addInstruction} disabled={!newInstruction.trim()}>
            <Plus className="h-3.5 w-3.5 mr-1" />Aggiungi
          </Button>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-purple-400" />
          </div>
        )}

        {!loading && instructions.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-6">Nessuna istruzione salvata</p>
        )}

        {!loading && Object.entries(grouped).map(([scope, items]) => (
          <div key={scope} className="space-y-1.5">
            <h3 className="text-xs font-semibold text-gray-600 flex items-center gap-1.5">
              <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${SCOPE_COLORS[scope] || SCOPE_COLORS.general}`}>
                {SCOPE_LABELS[scope] || scope}
              </span>
              <span className="text-gray-400">({items.length})</span>
            </h3>
            {items.map((inst) => (
              <div key={inst.id} className="flex items-start gap-2 bg-gray-50 rounded-lg px-3 py-2 group">
                <span className="flex-1 text-sm text-gray-700">
                  {inst.instruction}
                  {inst.counterparty_name && (
                    <span className="text-xs text-blue-500 ml-1.5">({inst.counterparty_name})</span>
                  )}
                </span>
                <span className="text-[10px] text-gray-400 shrink-0 mt-0.5">
                  {inst.source === 'ai_chat' ? 'da chat' : 'manuale'}
                </span>
                <button
                  onClick={() => removeInstruction(inst.id)}
                  className="text-gray-300 hover:text-red-500 shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Rimuovi"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

// ============================================================
// BRAIN AI ACTIVATION CARD
// ============================================================
function BrainActivationCard({ companyId }: { companyId: string }) {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<BrainBackfillResult | null>(null)
  const [error, setError] = useState('')

  const handleActivate = async () => {
    setRunning(true)
    setError('')
    setResult(null)
    try {
      const res = await triggerFullBrainBackfill(companyId, (partial) => {
        // Live progress updates from each batch round
        setResult({ ...partial })
      })
      setResult(res)
    } catch (err: any) {
      setError(err.message || 'Errore durante il backfill')
    }
    setRunning(false)
  }

  // Compute totals from result
  const show = result
  const entityTotal = show
    ? Object.values(show.entities).reduce((sum, r) => sum + r.processed, 0)
    : 0
  const entityErrors = show
    ? Object.values(show.entities).reduce((sum, r) => sum + r.errors, 0)
    : 0
  const entityRemaining = show
    ? Object.values(show.entities).reduce((sum, r) => sum + r.remaining, 0)
    : 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Brain className="h-4 w-4 text-violet-600" />
          Brain AI — Embeddings
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-gray-500">
          Calcola gli embeddings vettoriali per tutti i conti, categorie, articoli, centri di costo
          e la memoria aziendale. Necessario per la classificazione AI intelligente (Haiku pre-flight).
          Gli embeddings vengono aggiornati automaticamente ad ogni modifica, ma puoi forzare un ricalcolo completo.
        </p>

        <Button
          onClick={handleActivate}
          disabled={running}
          className="bg-violet-600 hover:bg-violet-700"
        >
          {running ? (
            <>
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              Calcolo in corso{entityTotal > 0 ? ` (${entityTotal + (show?.memory.processed || 0)} processati)` : ''}...
            </>
          ) : (
            <>
              <Brain className="h-3.5 w-3.5 mr-1.5" />
              {result ? 'Ricalcola Embeddings' : 'Attiva Brain AI'}
            </>
          )}
        </Button>

        {error && (
          <div className="flex items-center gap-2 text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">
            <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
            {error}
          </div>
        )}

        {show && (
          <div className={`rounded-lg px-3 py-2.5 space-y-1.5 ${running ? 'bg-violet-50/60 border border-violet-200' : 'bg-violet-50'}`}>
            <div className="flex items-center gap-2 text-xs font-semibold text-violet-800">
              {running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-500" />
              ) : (
                <CheckCircle className="h-3.5 w-3.5 text-emerald-600" />
              )}
              {running ? 'Embedding in corso...' : 'Backfill completato'}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-600">
              <span>Entità processate:</span>
              <span className="font-medium text-gray-900">{entityTotal}</span>
              <span>Memoria processata:</span>
              <span className="font-medium text-gray-900">{show.memory.processed}</span>
              {(entityErrors + show.memory.errors) > 0 && (
                <>
                  <span className="text-amber-600">Errori:</span>
                  <span className="font-medium text-amber-700">{entityErrors + show.memory.errors}</span>
                </>
              )}
              {(entityRemaining + show.memory.remaining) > 0 && (
                <>
                  <span>Rimanenti:</span>
                  <span className="font-medium text-gray-700">{entityRemaining + show.memory.remaining}</span>
                </>
              )}
            </div>
            {Object.entries(show.entities).length > 0 && (
              <div className="text-[10px] text-gray-400 pt-1 border-t border-violet-100">
                {Object.entries(show.entities).map(([type, r]) => (
                  <span key={type} className="mr-3">
                    {type.replace(/_/g, ' ')}: {r.processed}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ============================================================
// MAIN PAGE
// ============================================================
export default function ImpostazioniPage() {
  const { user } = useAuth()
  const { company, refetch: refetchCompany } = useCompany()
  const companyId = company?.id || null

  // Tab state
  const [activeTab, setActiveTab] = useState<SettingsTab>('generale')

  // Bank accounts
  const [bankAccounts, setBankAccounts] = useState<any[]>([])
  const [bankModal, setBankModal] = useState<{ account?: any } | null>(null)
  const [deleteModal, setDeleteModal] = useState<any>(null)
  const [deleting, setDeleting] = useState(false)
  const [paymentDefaults, setPaymentDefaults] = useState({ default_dso_days: '30', default_pso_days: '30' })
  const [savingDefaults, setSavingDefaults] = useState(false)

  // Opening balance inline edit
  const [obEdit, setObEdit] = useState<{ id: string; amount: string; date: string } | null>(null)
  const [obSaving, setObSaving] = useState(false)

  const loadBankAccounts = useCallback(async () => {
    if (!companyId) return
    const { data } = await supabase
      .from('bank_accounts')
      .select('*')
      .eq('company_id', companyId)
      .order('created_at', { ascending: true })
    setBankAccounts(data || [])
  }, [companyId])

  useEffect(() => { loadBankAccounts() }, [loadBankAccounts])

  useEffect(() => {
    setPaymentDefaults({
      default_dso_days: company?.default_dso_days != null ? String(company.default_dso_days) : '30',
      default_pso_days: company?.default_pso_days != null ? String(company.default_pso_days) : '30',
    })
  }, [company?.default_dso_days, company?.default_pso_days])

  const handleDeleteAccount = async () => {
    if (!deleteModal) return
    setDeleting(true)
    try {
      // Delete transactions first
      await supabase.from('bank_transactions').delete().eq('bank_account_id', deleteModal.id)
      await supabase.from('bank_accounts').delete().eq('id', deleteModal.id)
      await loadBankAccounts()
    } catch (e: any) {
      alert('Errore: ' + e.message)
    }
    setDeleting(false)
    setDeleteModal(null)
  }

  const handleSavePaymentDefaults = async () => {
    if (!companyId) return

    const dso = Math.max(0, Number(paymentDefaults.default_dso_days || 30))
    const pso = Math.max(0, Number(paymentDefaults.default_pso_days || 30))

    setSavingDefaults(true)
    try {
      const { error, count } = await supabase
        .from('companies')
        .update({
          default_dso_days: Math.round(dso),
          default_pso_days: Math.round(pso),
          updated_at: new Date().toISOString(),
        }, { count: 'exact' })
        .eq('id', companyId)
      if (error) throw error
      if (count === 0) {
        alert('Impossibile aggiornare: verifica di avere il ruolo owner/admin.')
        setSavingDefaults(false)
        return
      }
      await refetchCompany()
      alert('Default scadenze salvati.')
    } catch (e: any) {
      alert('Errore salvataggio default scadenze: ' + e.message)
    }
    setSavingDefaults(false)
  }

  const handleSaveOpeningBalance = async () => {
    if (!obEdit) return
    const numAmount = Number(obEdit.amount.replace(',', '.'))
    if (isNaN(numAmount) || !obEdit.date) {
      alert('Importo e data sono obbligatori')
      return
    }
    setObSaving(true)
    try {
      await saveOpeningBalance(obEdit.id, numAmount, obEdit.date, true)
      await loadBankAccounts()
      setObEdit(null)
    } catch (e: any) {
      alert('Errore: ' + e.message)
    }
    setObSaving(false)
  }

  const fmtEur = (n: number | null | undefined) => {
    if (n == null) return '—'
    return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(n)
  }

  const fmtDate = (d: string | null | undefined) => {
    if (!d) return ''
    const [y, m, dd] = d.split('-')
    return `${dd}/${m}/${y}`
  }

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Impostazioni</h1>
        <p className="text-muted-foreground text-sm mt-1">Configura il tuo profilo e le impostazioni aziendali</p>
      </div>

      {/* Tab navigation */}
      <div className="flex gap-1 border-b border-gray-200 -mb-2">
        {TABS.map(t => {
          const Icon = t.icon
          const isActive = activeTab === t.key
          return (
            <button key={t.key} onClick={() => setActiveTab(t.key)}
              className={`flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold border-b-2 transition-all ${
                isActive
                  ? 'text-sky-700 border-sky-500 bg-sky-50/50'
                  : 'text-gray-400 border-transparent hover:text-gray-600 hover:bg-gray-50'
              }`}>
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          )
        })}
      </div>

      {/* Tab content */}
      {activeTab === 'categorie' && companyId && <CategoriesTab companyId={companyId} />}
      {activeTab === 'progetti' && companyId && <ProjectsTab companyId={companyId} />}
      {activeTab === 'piano-conti' && companyId && <ChartOfAccountsTab companyId={companyId} />}
      {activeTab === 'istruzioni-ai' && companyId && (
        <>
          <BrainActivationCard companyId={companyId} />
          <InstructionsTab companyId={companyId} />
        </>
      )}
      {(activeTab === 'categorie' || activeTab === 'progetti' || activeTab === 'piano-conti' || activeTab === 'istruzioni-ai') && !companyId && (
        <p className="text-sm text-gray-400 text-center py-8">Importa almeno una fattura per configurare le classificazioni</p>
      )}

      {/* Generale tab content */}
      {activeTab === 'generale' && <>
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
              <div className="pt-2 border-t">
                <Label className="text-xs text-muted-foreground">Default scadenze (giorni)</Label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
                  <div>
                    <Label className="text-xs">Default DSO (incassi clienti)</Label>
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      value={paymentDefaults.default_dso_days}
                      onChange={(e) => setPaymentDefaults((p) => ({ ...p, default_dso_days: e.target.value }))}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Default PSO (pagamenti fornitori)</Label>
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      value={paymentDefaults.default_pso_days}
                      onChange={(e) => setPaymentDefaults((p) => ({ ...p, default_pso_days: e.target.value }))}
                      className="mt-1"
                    />
                  </div>
                </div>
                <div className="mt-3">
                  <Button size="sm" onClick={handleSavePaymentDefaults} disabled={savingDefaults}>
                    {savingDefaults ? 'Salvataggio...' : 'Salva default scadenze'}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              I dati dell'azienda saranno estratti automaticamente dalle fatture importate.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Conti bancari */}
      {companyId && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Landmark className="h-4 w-4" /> Conti Bancari
              </CardTitle>
              <Button size="sm" variant="outline" onClick={() => setBankModal({})}>
                <Plus className="h-3.5 w-3.5 mr-1.5" />Aggiungi
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {bankAccounts.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">Nessun conto bancario configurato</p>
            ) : (
              <div className="space-y-2">
                {bankAccounts.map(acc => (
                  <div key={acc.id} className="p-3 bg-gray-50 rounded-lg border border-gray-100 space-y-2">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900">{acc.name}</p>
                        <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                          {acc.bank_name && <span className="text-xs text-gray-500">{acc.bank_name}</span>}
                          {acc.iban && <span className="text-[10px] font-mono text-gray-400">{acc.iban}</span>}
                        </div>
                      </div>
                      <div className="flex gap-1 flex-shrink-0">
                        <button
                          onClick={() => setBankModal({ account: acc })}
                          className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-200 rounded-md transition-colors"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => setDeleteModal(acc)}
                          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Opening balance section */}
                    <div className="border-t border-gray-200 pt-2">
                      {obEdit != null && obEdit.id === acc.id ? (
                        <div className="flex items-end gap-2 flex-wrap">
                          <div>
                            <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Saldo iniziale (€)</label>
                            <input
                              type="text"
                              inputMode="decimal"
                              value={obEdit.amount}
                              onChange={e => setObEdit(prev => prev ? { ...prev, amount: e.target.value } : prev)}
                              className="px-2 py-1 text-xs border border-gray-300 rounded-md w-32 focus:ring-2 focus:ring-sky-500 outline-none"
                              placeholder="12345.67"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Data</label>
                            <input
                              type="date"
                              value={obEdit.date}
                              onChange={e => setObEdit(prev => prev ? { ...prev, date: e.target.value } : prev)}
                              className="px-2 py-1 text-xs border border-gray-300 rounded-md focus:ring-2 focus:ring-sky-500 outline-none"
                            />
                          </div>
                          <Button size="sm" onClick={handleSaveOpeningBalance} disabled={obSaving}>
                            {obSaving ? '...' : 'Salva'}
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => setObEdit(null)} disabled={obSaving}>
                            Annulla
                          </Button>
                        </div>
                      ) : acc.opening_balance_confirmed ? (
                        <div className="flex items-center gap-2 text-xs">
                          <CheckCircle className="h-3 w-3 text-emerald-500 flex-shrink-0" />
                          <span className="text-gray-600">
                            Saldo iniziale: <span className="font-semibold text-gray-800">{fmtEur(acc.opening_balance)}</span>
                          </span>
                          {acc.opening_balance_date && (
                            <span className="text-gray-400">al {fmtDate(acc.opening_balance_date)}</span>
                          )}
                          <button
                            onClick={() => setObEdit({
                              id: acc.id,
                              amount: acc.opening_balance != null ? String(acc.opening_balance) : '',
                              date: acc.opening_balance_date || '',
                            })}
                            className="text-sky-600 hover:text-sky-800 hover:underline ml-1"
                          >
                            Modifica
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-gray-400">Saldo iniziale non configurato</span>
                          <button
                            onClick={() => setObEdit({ id: acc.id, amount: '', date: '' })}
                            className="text-sky-600 hover:text-sky-800 hover:underline"
                          >
                            Imposta
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
      </>}

      {/* Modals */}
      {bankModal && companyId && (
        <BankAccountModal
          account={bankModal.account}
          companyId={companyId}
          onSave={() => { loadBankAccounts(); setBankModal(null) }}
          onClose={() => setBankModal(null)}
        />
      )}
      {deleteModal && (
        <DeleteBankModal
          name={deleteModal.name}
          onConfirm={handleDeleteAccount}
          onCancel={() => !deleting && setDeleteModal(null)}
        />
      )}
    </div>
  )
}
