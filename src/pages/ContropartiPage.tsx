import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useCompany } from '@/hooks/useCompany'
import {
  loadCounterparties,
  createManualCounterparty,
  updateCounterparty,
  verifyCounterparty,
  rejectCounterparty,
  loadInvoicesByCounterparty,
  buildCounterpartyAnalytics,
  type Counterparty,
  type CounterpartyLegalType,
  type CounterpartyRole,
  type CounterpartyStatus,
} from '@/lib/counterpartyService'
import { fmtDate, fmtEur } from '@/lib/utils'
import {
  Users,
  Plus,
  Search,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Filter,
  RefreshCw,
} from 'lucide-react'
import {
  ResponsiveContainer,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Bar,
  Legend,
} from 'recharts'

const ROLE_LABEL: Record<CounterpartyRole, string> = {
  client: 'Cliente',
  supplier: 'Fornitore',
  both: 'Cliente + Fornitore',
}

const STATUS_LABEL: Record<CounterpartyStatus, string> = {
  pending: 'Da verificare',
  verified: 'Verificata',
  rejected: 'Respinta',
}

const LEGAL_TYPE_LABEL: Record<CounterpartyLegalType, string> = {
  azienda: 'Azienda',
  pa: 'PA',
  professionista: 'Professionista',
  persona: 'Persona',
  altro: 'Altro',
}

const STATUS_BADGE: Record<CounterpartyStatus, string> = {
  pending: 'bg-amber-100 text-amber-800',
  verified: 'bg-emerald-100 text-emerald-800',
  rejected: 'bg-red-100 text-red-800',
}

const ROLE_BADGE: Record<CounterpartyRole, string> = {
  client: 'bg-sky-100 text-sky-800',
  supplier: 'bg-indigo-100 text-indigo-800',
  both: 'bg-violet-100 text-violet-800',
}

function CounterpartyCreateModal({
  open,
  onClose,
  onCreated,
  companyId,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => void
  companyId: string
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({
    name: '',
    type: 'client' as CounterpartyRole,
    status: 'pending' as CounterpartyStatus,
    vat_number: '',
    fiscal_code: '',
    legal_type: 'azienda' as CounterpartyLegalType,
    address: '',
    notes: '',
  })

  if (!open) return null

  const submit = async () => {
    if (!form.name.trim()) {
      setError('Nome obbligatorio')
      return
    }
    setSaving(true)
    setError('')
    try {
      await createManualCounterparty(companyId, {
        name: form.name,
        type: form.type,
        status: form.status,
        vat_number: form.vat_number || null,
        fiscal_code: form.fiscal_code || null,
        legal_type: form.legal_type,
        address: form.address || null,
        notes: form.notes || null,
      })
      onCreated()
      onClose()
      setForm({
        name: '',
        type: 'client',
        status: 'pending',
        vat_number: '',
        fiscal_code: '',
        legal_type: 'azienda',
        address: '',
        notes: '',
      })
    } catch (e: any) {
      setError(e.message || 'Errore creazione controparte')
    }
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl p-6 max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Nuova controparte</h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <Label className="text-xs">Nome *</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="mt-1"
              placeholder="Ragione sociale o nominativo"
            />
          </div>

          <div>
            <Label className="text-xs">Ruolo</Label>
            <select
              value={form.type}
              onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as CounterpartyRole }))}
              className="w-full mt-1 border rounded-md px-3 py-2 text-sm"
            >
              <option value="client">Cliente</option>
              <option value="supplier">Fornitore</option>
              <option value="both">Cliente + Fornitore</option>
            </select>
          </div>

          <div>
            <Label className="text-xs">Stato</Label>
            <select
              value={form.status}
              onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as CounterpartyStatus }))}
              className="w-full mt-1 border rounded-md px-3 py-2 text-sm"
            >
              <option value="pending">Da verificare</option>
              <option value="verified">Verificata</option>
              <option value="rejected">Respinta</option>
            </select>
          </div>

          <div>
            <Label className="text-xs">Partita IVA</Label>
            <Input
              value={form.vat_number}
              onChange={(e) => setForm((f) => ({ ...f, vat_number: e.target.value }))}
              className="mt-1"
              placeholder="IT12345678901"
            />
          </div>

          <div>
            <Label className="text-xs">Codice Fiscale</Label>
            <Input
              value={form.fiscal_code}
              onChange={(e) => setForm((f) => ({ ...f, fiscal_code: e.target.value }))}
              className="mt-1"
            />
          </div>

          <div>
            <Label className="text-xs">Tipologia</Label>
            <select
              value={form.legal_type}
              onChange={(e) => setForm((f) => ({ ...f, legal_type: e.target.value as CounterpartyLegalType }))}
              className="w-full mt-1 border rounded-md px-3 py-2 text-sm"
            >
              <option value="azienda">Azienda</option>
              <option value="pa">PA</option>
              <option value="professionista">Professionista</option>
              <option value="persona">Persona</option>
              <option value="altro">Altro</option>
            </select>
          </div>

          <div>
            <Label className="text-xs">Indirizzo</Label>
            <Input
              value={form.address}
              onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
              className="mt-1"
            />
          </div>

          <div className="sm:col-span-2">
            <Label className="text-xs">Note</Label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              className="w-full mt-1 border rounded-md px-3 py-2 text-sm min-h-[70px]"
            />
          </div>
        </div>

        {error && <p className="text-sm text-red-600 mt-3">{error}</p>}

        <div className="flex justify-end gap-2 mt-5">
          <Button variant="outline" onClick={onClose}>Annulla</Button>
          <Button onClick={submit} disabled={saving}>{saving ? 'Salvataggio...' : 'Crea controparte'}</Button>
        </div>
      </div>
    </div>
  )
}

export default function ContropartiPage() {
  const { company } = useCompany()
  const companyId = company?.id || null
  const [searchParams] = useSearchParams()

  const [counterparties, setCounterparties] = useState<Counterparty[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)

  const [roleFilter, setRoleFilter] = useState<'all' | CounterpartyRole>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | CounterpartyStatus>('all')
  const [legalTypeFilter, setLegalTypeFilter] = useState<'all' | CounterpartyLegalType>('all')
  const [query, setQuery] = useState('')

  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [invoiceDirectionFilter, setInvoiceDirectionFilter] = useState<'all' | 'in' | 'out'>('all')

  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [linkedInvoices, setLinkedInvoices] = useState<Array<{
    id: string
    counterparty_id: string
    direction: 'in' | 'out'
    doc_type: string
    number: string
    date: string
    total_amount: number
    payment_status: string
    counterparty_status_snapshot: string | null
  }>>([])

  const [draft, setDraft] = useState<{
    name: string
    type: CounterpartyRole
    status: CounterpartyStatus
    legal_type: CounterpartyLegalType
    vat_number: string
    fiscal_code: string
    address: string
    notes: string
  } | null>(null)

  const reloadCounterparties = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    setError('')
    try {
      const data = await loadCounterparties(companyId, {
        role: roleFilter,
        status: statusFilter,
        legalType: legalTypeFilter,
        query,
      })
      setCounterparties(data)

      const paramId = searchParams.get('counterpartyId')
      if (paramId && data.some((cp) => cp.id === paramId)) {
        setFocusedId(paramId)
      } else if (!focusedId && data.length > 0) {
        setFocusedId(data[0].id)
      } else if (focusedId && !data.some((cp) => cp.id === focusedId)) {
        setFocusedId(data[0]?.id || null)
      }
    } catch (e: any) {
      setError(e.message || 'Errore caricamento controparti')
    }
    setLoading(false)
  }, [companyId, roleFilter, statusFilter, legalTypeFilter, query, focusedId, searchParams])

  useEffect(() => {
    reloadCounterparties()
  }, [reloadCounterparties])

  const focused = useMemo(
    () => counterparties.find((cp) => cp.id === focusedId) || null,
    [counterparties, focusedId],
  )

  useEffect(() => {
    if (!focused) {
      setDraft(null)
      return
    }
    setDraft({
      name: focused.name || '',
      type: focused.type,
      status: focused.status,
      legal_type: focused.legal_type || 'altro',
      vat_number: focused.vat_number || '',
      fiscal_code: focused.fiscal_code || '',
      address: focused.address || '',
      notes: focused.notes || '',
    })
  }, [focused])

  const analyticsTargetIds = useMemo(() => {
    if (selectedIds.size > 0) return Array.from(selectedIds)
    if (focusedId) return [focusedId]
    return []
  }, [selectedIds, focusedId])

  const reloadLinkedInvoices = useCallback(async () => {
    if (!companyId || analyticsTargetIds.length === 0) {
      setLinkedInvoices([])
      return
    }
    try {
      const rows = await loadInvoicesByCounterparty(companyId, analyticsTargetIds, {
        direction: invoiceDirectionFilter,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      })
      setLinkedInvoices(rows)
    } catch (e: any) {
      setError(e.message || 'Errore caricamento fatture collegate')
    }
  }, [companyId, analyticsTargetIds, invoiceDirectionFilter, dateFrom, dateTo])

  useEffect(() => {
    reloadLinkedInvoices()
  }, [reloadLinkedInvoices])

  const analytics = useMemo(() => {
    const rows = linkedInvoices.map((r) => ({
      counterparty_id: r.counterparty_id,
      direction: r.direction,
      date: r.date,
      total_amount: r.total_amount,
    }))
    return buildCounterpartyAnalytics(rows, counterparties)
  }, [linkedInvoices, counterparties])

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const clearSelection = () => setSelectedIds(new Set())

  const saveFocused = async () => {
    if (!focused || !draft) return
    setSaving(true)
    setError('')
    try {
      await updateCounterparty(focused.id, {
        name: draft.name,
        type: draft.type,
        status: draft.status,
        legal_type: draft.legal_type,
        vat_number: draft.vat_number || null,
        fiscal_code: draft.fiscal_code || null,
        address: draft.address || null,
        notes: draft.notes || null,
      })
      await reloadCounterparties()
      await reloadLinkedInvoices()
    } catch (e: any) {
      setError(e.message || 'Errore salvataggio')
    }
    setSaving(false)
  }

  const verifyFocused = async () => {
    if (!focused) return
    setSaving(true)
    setError('')
    try {
      await verifyCounterparty(focused.id)
      await reloadCounterparties()
      await reloadLinkedInvoices()
    } catch (e: any) {
      setError(e.message || 'Errore verifica')
    }
    setSaving(false)
  }

  const rejectFocused = async () => {
    if (!focused) return
    const reason = window.prompt('Motivo rifiuto controparte', 'Dati fiscali incompleti o non coerenti') || undefined
    setSaving(true)
    setError('')
    try {
      await rejectCounterparty(focused.id, reason)
      await reloadCounterparties()
      await reloadLinkedInvoices()
    } catch (e: any) {
      setError(e.message || 'Errore rifiuto')
    }
    setSaving(false)
  }

  const pendingCount = counterparties.filter((c) => c.status === 'pending').length

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Controparti</h1>
          <p className="text-muted-foreground text-sm mt-1">Clienti e fornitori da fatture/import manuale con verifica anagrafica</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={reloadCounterparties} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />Aggiorna
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />Nuova controparte
          </Button>
        </div>
      </div>

      {pendingCount > 0 && (
        <div className="flex items-center gap-2 p-3 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-sm">
          <AlertTriangle className="h-4 w-4" />
          {pendingCount} controparti in stato "Da verificare"
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg border border-red-200 bg-red-50 text-red-700 text-sm">
          <XCircle className="h-4 w-4" />{error}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[360px_1fr] gap-4">
        <Card className="h-[calc(100vh-210px)] flex flex-col">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="h-4 w-4" />Lista controparti
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col gap-3 overflow-hidden">
            <div className="space-y-2">
              <div className="flex gap-1">
                {([
                  ['all', 'Tutte'],
                  ['client', 'Clienti'],
                  ['supplier', 'Fornitori'],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setRoleFilter(key as 'all' | CounterpartyRole)}
                    className={`px-2.5 py-1 text-xs rounded-md border ${
                      roleFilter === key
                        ? 'bg-sky-100 text-sky-700 border-sky-300'
                        : 'bg-white text-gray-600 border-gray-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <Search className="h-3.5 w-3.5 text-gray-400" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Ricerca nome, P.IVA o CF"
                  className="h-8 text-xs"
                />
              </div>

              <div className="flex items-center gap-2">
                <Filter className="h-3.5 w-3.5 text-gray-400" />
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as 'all' | CounterpartyStatus)}
                  className="flex-1 border rounded-md px-2 py-1 text-xs"
                >
                  <option value="all">Tutti gli stati</option>
                  <option value="pending">Da verificare</option>
                  <option value="verified">Verificate</option>
                  <option value="rejected">Respinte</option>
                </select>
                <select
                  value={legalTypeFilter}
                  onChange={(e) => setLegalTypeFilter(e.target.value as 'all' | CounterpartyLegalType)}
                  className="flex-1 border rounded-md px-2 py-1 text-xs"
                >
                  <option value="all">Tutte le tipologie</option>
                  <option value="azienda">Azienda</option>
                  <option value="pa">PA</option>
                  <option value="professionista">Professionista</option>
                  <option value="persona">Persona</option>
                  <option value="altro">Altro</option>
                </select>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto border rounded-lg divide-y">
              {loading ? (
                <div className="text-center py-8 text-sm text-gray-500">Caricamento...</div>
              ) : counterparties.length === 0 ? (
                <div className="text-center py-8 text-sm text-gray-500">Nessuna controparte trovata</div>
              ) : (
                counterparties.map((cp) => {
                  const selected = focusedId === cp.id
                  const checked = selectedIds.has(cp.id)
                  return (
                    <div
                      key={cp.id}
                      className={`px-3 py-2 cursor-pointer ${selected ? 'bg-sky-50' : 'hover:bg-gray-50'}`}
                      onClick={() => setFocusedId(cp.id)}
                    >
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            e.stopPropagation()
                            toggleSelect(cp.id)
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="mt-0.5"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-gray-900 truncate">{cp.name}</p>
                          <div className="flex flex-wrap gap-1 mt-1">
                            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${STATUS_BADGE[cp.status]}`}>
                              {STATUS_LABEL[cp.status]}
                            </span>
                            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${ROLE_BADGE[cp.type]}`}>
                              {ROLE_LABEL[cp.type]}
                            </span>
                            {cp.legal_type && (
                              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-700">
                                {LEGAL_TYPE_LABEL[cp.legal_type]}
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-gray-500 mt-1 truncate">
                            {cp.vat_number || cp.fiscal_code || 'Senza P.IVA/CF'}
                          </p>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>

            {selectedIds.size > 0 && (
              <div className="flex items-center justify-between text-xs bg-sky-50 border border-sky-200 rounded-md px-2 py-1.5">
                <span>{selectedIds.size} selezionate per analytics</span>
                <button className="text-sky-700 font-medium" onClick={clearSelection}>Deseleziona</button>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          {!focused || !draft ? (
            <Card>
              <CardContent className="p-10 text-center text-gray-500">Seleziona una controparte dalla lista</CardContent>
            </Card>
          ) : (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Dettaglio controparte</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="sm:col-span-2">
                      <Label className="text-xs">Nome</Label>
                      <Input
                        value={draft.name}
                        onChange={(e) => setDraft((d) => d ? ({ ...d, name: e.target.value }) : d)}
                        className="mt-1"
                      />
                    </div>

                    <div>
                      <Label className="text-xs">Ruolo</Label>
                      <select
                        value={draft.type}
                        onChange={(e) => setDraft((d) => d ? ({ ...d, type: e.target.value as CounterpartyRole }) : d)}
                        className="w-full mt-1 border rounded-md px-3 py-2 text-sm"
                      >
                        <option value="client">Cliente</option>
                        <option value="supplier">Fornitore</option>
                        <option value="both">Cliente + Fornitore</option>
                      </select>
                    </div>

                    <div>
                      <Label className="text-xs">Stato</Label>
                      <select
                        value={draft.status}
                        onChange={(e) => setDraft((d) => d ? ({ ...d, status: e.target.value as CounterpartyStatus }) : d)}
                        className="w-full mt-1 border rounded-md px-3 py-2 text-sm"
                      >
                        <option value="pending">Da verificare</option>
                        <option value="verified">Verificata</option>
                        <option value="rejected">Respinta</option>
                      </select>
                    </div>

                    <div>
                      <Label className="text-xs">Partita IVA</Label>
                      <Input
                        value={draft.vat_number}
                        onChange={(e) => setDraft((d) => d ? ({ ...d, vat_number: e.target.value }) : d)}
                        className="mt-1"
                      />
                    </div>

                    <div>
                      <Label className="text-xs">Codice Fiscale</Label>
                      <Input
                        value={draft.fiscal_code}
                        onChange={(e) => setDraft((d) => d ? ({ ...d, fiscal_code: e.target.value }) : d)}
                        className="mt-1"
                      />
                    </div>

                    <div>
                      <Label className="text-xs">Tipologia</Label>
                      <select
                        value={draft.legal_type}
                        onChange={(e) => setDraft((d) => d ? ({ ...d, legal_type: e.target.value as CounterpartyLegalType }) : d)}
                        className="w-full mt-1 border rounded-md px-3 py-2 text-sm"
                      >
                        <option value="azienda">Azienda</option>
                        <option value="pa">PA</option>
                        <option value="professionista">Professionista</option>
                        <option value="persona">Persona</option>
                        <option value="altro">Altro</option>
                      </select>
                    </div>

                    <div>
                      <Label className="text-xs">Indirizzo</Label>
                      <Input
                        value={draft.address}
                        onChange={(e) => setDraft((d) => d ? ({ ...d, address: e.target.value }) : d)}
                        className="mt-1"
                      />
                    </div>

                    <div className="sm:col-span-2">
                      <Label className="text-xs">Note</Label>
                      <textarea
                        value={draft.notes}
                        onChange={(e) => setDraft((d) => d ? ({ ...d, notes: e.target.value }) : d)}
                        className="w-full mt-1 border rounded-md px-3 py-2 text-sm min-h-[70px]"
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    <Button size="sm" onClick={saveFocused} disabled={saving}>Salva</Button>
                    <Button size="sm" variant="outline" onClick={verifyFocused} disabled={saving}>
                      <CheckCircle className="h-3.5 w-3.5 mr-1.5" />Verifica
                    </Button>
                    <Button size="sm" variant="outline" onClick={rejectFocused} disabled={saving}>
                      <XCircle className="h-3.5 w-3.5 mr-1.5" />Rifiuta
                    </Button>
                    <p className="text-xs text-gray-500 ml-auto">Creata il {fmtDate(focused.created_at)}</p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Analytics controparti</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="date"
                      value={dateFrom}
                      onChange={(e) => setDateFrom(e.target.value)}
                      className="border rounded-md px-2 py-1 text-xs"
                    />
                    <span className="text-xs text-gray-500">→</span>
                    <input
                      type="date"
                      value={dateTo}
                      onChange={(e) => setDateTo(e.target.value)}
                      className="border rounded-md px-2 py-1 text-xs"
                    />
                    <select
                      value={invoiceDirectionFilter}
                      onChange={(e) => setInvoiceDirectionFilter(e.target.value as 'all' | 'in' | 'out')}
                      className="border rounded-md px-2 py-1 text-xs"
                    >
                      <option value="all">Attive + Passive</option>
                      <option value="out">Solo Attive</option>
                      <option value="in">Solo Passive</option>
                    </select>
                  </div>

                  <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
                    <div className="p-2 rounded border bg-emerald-50">
                      <p className="text-[10px] text-emerald-700 uppercase">Totale attive</p>
                      <p className="text-sm font-bold text-emerald-700">{fmtEur(analytics.totalActiveAmount)}</p>
                    </div>
                    <div className="p-2 rounded border bg-red-50">
                      <p className="text-[10px] text-red-700 uppercase">Totale passive</p>
                      <p className="text-sm font-bold text-red-700">{fmtEur(analytics.totalPassiveAmount)}</p>
                    </div>
                    <div className="p-2 rounded border bg-blue-50">
                      <p className="text-[10px] text-blue-700 uppercase">Saldo netto</p>
                      <p className="text-sm font-bold text-blue-700">{fmtEur(analytics.totalNetAmount)}</p>
                    </div>
                    <div className="p-2 rounded border bg-gray-50">
                      <p className="text-[10px] text-gray-700 uppercase">N. attive</p>
                      <p className="text-sm font-bold text-gray-800">{analytics.countActive}</p>
                    </div>
                    <div className="p-2 rounded border bg-gray-50">
                      <p className="text-[10px] text-gray-700 uppercase">N. passive</p>
                      <p className="text-sm font-bold text-gray-800">{analytics.countPassive}</p>
                    </div>
                  </div>

                  <div className="h-64 border rounded-lg p-2">
                    {analytics.trend.length === 0 ? (
                      <div className="h-full flex items-center justify-center text-sm text-gray-500">Nessun dato nel periodo</div>
                    ) : (
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={analytics.trend}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="month" />
                          <YAxis />
                          <Tooltip formatter={(v: any) => fmtEur(Number(v || 0))} />
                          <Legend />
                          <Bar dataKey="activeAmount" name="Attive" stackId="a" fill="#059669" />
                          <Bar dataKey="passiveAmount" name="Passive" stackId="a" fill="#dc2626" />
                        </BarChart>
                      </ResponsiveContainer>
                    )}
                  </div>

                  <div className="border rounded-lg overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="text-left px-3 py-2">Controparte</th>
                          <th className="text-right px-3 py-2">Attive</th>
                          <th className="text-right px-3 py-2">Passive</th>
                          <th className="text-right px-3 py-2">N. attive</th>
                          <th className="text-right px-3 py-2">N. passive</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analytics.byCounterparty.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="text-center py-4 text-gray-500">Nessun dato</td>
                          </tr>
                        ) : (
                          analytics.byCounterparty.map((row) => (
                            <tr key={row.counterparty_id} className="border-t">
                              <td className="px-3 py-2">{row.counterparty_name}</td>
                              <td className="px-3 py-2 text-right text-emerald-700 font-medium">{fmtEur(row.activeAmount)}</td>
                              <td className="px-3 py-2 text-right text-red-700 font-medium">{fmtEur(row.passiveAmount)}</td>
                              <td className="px-3 py-2 text-right">{row.activeCount}</td>
                              <td className="px-3 py-2 text-right">{row.passiveCount}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Fatture collegate</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto border rounded-lg">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="text-left px-3 py-2">Data</th>
                          <th className="text-left px-3 py-2">Direzione</th>
                          <th className="text-left px-3 py-2">Doc</th>
                          <th className="text-left px-3 py-2">Numero</th>
                          <th className="text-right px-3 py-2">Totale</th>
                          <th className="text-left px-3 py-2">Stato pagamento</th>
                          <th className="text-left px-3 py-2">Stato controparte</th>
                        </tr>
                      </thead>
                      <tbody>
                        {linkedInvoices.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="text-center py-4 text-gray-500">Nessuna fattura collegata nel periodo</td>
                          </tr>
                        ) : (
                          linkedInvoices.map((inv) => (
                            <tr key={inv.id} className="border-t">
                              <td className="px-3 py-2">{fmtDate(inv.date)}</td>
                              <td className="px-3 py-2">{inv.direction === 'out' ? 'Attiva' : 'Passiva'}</td>
                              <td className="px-3 py-2">{inv.doc_type}</td>
                              <td className="px-3 py-2">{inv.number}</td>
                              <td className="px-3 py-2 text-right font-medium">{fmtEur(inv.total_amount)}</td>
                              <td className="px-3 py-2">{inv.payment_status}</td>
                              <td className="px-3 py-2">
                                {inv.counterparty_status_snapshot ? (
                                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${STATUS_BADGE[(inv.counterparty_status_snapshot as CounterpartyStatus)] || 'bg-gray-100 text-gray-700'}`}>
                                    {STATUS_LABEL[(inv.counterparty_status_snapshot as CounterpartyStatus)] || inv.counterparty_status_snapshot}
                                  </span>
                                ) : (
                                  '—'
                                )}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>

      {companyId && (
        <CounterpartyCreateModal
          open={showCreate}
          onClose={() => setShowCreate(false)}
          onCreated={reloadCounterparties}
          companyId={companyId}
        />
      )}
    </div>
  )
}
