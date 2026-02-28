// src/pages/ImpostazioniPage.tsx
import { useState, useEffect, useCallback } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/hooks/useAuth'
import { useCompany } from '@/hooks/useCompany'
import { Settings, Building2, Landmark, Pencil, Trash2, Plus, X, AlertTriangle } from 'lucide-react'
import { supabase } from '@/integrations/supabase/client'

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
// MAIN PAGE
// ============================================================
export default function ImpostazioniPage() {
  const { user } = useAuth()
  const { company } = useCompany()
  const companyId = company?.id || null

  // Bank accounts
  const [bankAccounts, setBankAccounts] = useState<any[]>([])
  const [bankModal, setBankModal] = useState<{ account?: any } | null>(null)
  const [deleteModal, setDeleteModal] = useState<any>(null)
  const [deleting, setDeleting] = useState(false)

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
                  <div key={acc.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border border-gray-100">
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
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}



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
