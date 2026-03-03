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
  loadInstallmentFlowsByCounterparty,
  buildCounterpartyAnalytics,
  syncCounterpartyRoles,
  type Counterparty,
  type CounterpartyInstallmentFlowRow,
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

const MONTH_LABELS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

type VatMode = 'IT' | 'INT'
type AnalyticsVatMode = 'excl' | 'incl'
type AnalyticsDateMode = 'invoice_date' | 'payment_date'
type AnalyticsPaymentAmountMode = 'net_paid' | 'total_installment'

function sanitizeVatInput(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function parseVatForUi(rawVat: string | null | undefined): { mode: VatMode; value: string } {
  const compact = sanitizeVatInput(rawVat || '')
  if (!compact) return { mode: 'IT', value: '' }

  if (compact.startsWith('IT')) {
    return { mode: 'IT', value: compact.slice(2) }
  }

  if (/^[A-Z]{2}[A-Z0-9]+$/.test(compact)) {
    return { mode: 'INT', value: compact }
  }

  return { mode: 'IT', value: compact }
}

function buildVatForSave(mode: VatMode, value: string): string | null {
  const compact = sanitizeVatInput(value)
  if (!compact) return null

  if (mode === 'IT') {
    return `IT${compact.replace(/^IT/, '')}`
  }

  return compact
}

function formatMonthKey(monthKey: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey)
  if (!match) return monthKey

  const monthIndex = Number(match[2]) - 1
  if (monthIndex < 0 || monthIndex > 11) return monthKey

  return `${MONTH_LABELS_EN[monthIndex]}-${match[1].slice(2)}`
}

function fmtEurOrDash(amount: number): string {
  return Math.abs(amount) < 0.005 ? '-' : fmtEur(amount)
}

function trimDecimals(v: string): string {
  return v.replace(/\.00$/, '').replace(/(\.\d*[1-9])0+$/, '$1')
}

function formatCompactNumber(value: number): string {
  const abs = Math.abs(Number(value || 0))
  if (abs >= 1_000_000_000) return `${trimDecimals((value / 1_000_000_000).toFixed(2))}B`
  if (abs >= 1_000_000) return `${trimDecimals((value / 1_000_000).toFixed(2))}M`
  if (abs >= 1_000) return `${trimDecimals((value / 1_000).toFixed(2))}K`
  return trimDecimals(value.toFixed(0))
}

function analyticsAmountByVatMode(
  inv: { total_amount: number; taxable_amount: number | null; tax_amount: number | null },
  mode: AnalyticsVatMode,
): number {
  if (mode === 'incl') return Number(inv.total_amount || 0)
  if (inv.taxable_amount != null) return Number(inv.taxable_amount || 0)
  if (inv.tax_amount != null) return Number(inv.total_amount || 0) - Number(inv.tax_amount || 0)
  return Number(inv.total_amount || 0)
}

function CounterpartyCreateModal({
  open,
  onClose,
  onCreated,
  companyId,
  defaultDsoDays,
  defaultPsoDays,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => void
  companyId: string
  defaultDsoDays: number
  defaultPsoDays: number
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({
    name: '',
    status: 'pending' as CounterpartyStatus,
    vat_mode: 'IT' as VatMode,
    vat_value: '',
    fiscal_code: '',
    legal_type: 'azienda' as CounterpartyLegalType,
    address: '',
    dso_days_override: '',
    pso_days_override: '',
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
        status: form.status,
        vat_number: buildVatForSave(form.vat_mode, form.vat_value),
        fiscal_code: form.fiscal_code || null,
        legal_type: form.legal_type,
        address: form.address || null,
        dso_days_override: form.dso_days_override === '' ? null : Number(form.dso_days_override),
        pso_days_override: form.pso_days_override === '' ? null : Number(form.pso_days_override),
        notes: form.notes || null,
      })

      onCreated()
      onClose()
      setForm({
        name: '',
        status: 'pending',
        vat_mode: 'IT',
        vat_value: '',
        fiscal_code: '',
        legal_type: 'azienda',
        address: '',
        dso_days_override: '',
        pso_days_override: '',
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
            <Label className="text-xs">Ruolo</Label>
            <div className="mt-1 border rounded-md px-3 py-2 text-sm text-gray-600 bg-gray-50">
              Auto da fatture (attive/passive)
            </div>
          </div>

          <div>
            <Label className="text-xs">Partita IVA</Label>
            <div className="mt-1 flex gap-2">
              <select
                value={form.vat_mode}
                onChange={(e) => setForm((f) => ({ ...f, vat_mode: e.target.value as VatMode }))}
                className="w-20 border rounded-md px-2 py-2 text-sm"
              >
                <option value="IT">IT</option>
                <option value="INT">Int.</option>
              </select>
              <Input
                value={form.vat_value}
                onChange={(e) => setForm((f) => ({ ...f, vat_value: sanitizeVatInput(e.target.value) }))}
                className="flex-1"
                placeholder={form.vat_mode === 'IT' ? '12345678901' : 'FR123456789'}
              />
            </div>
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

          <div>
            <Label className="text-xs">DSO (giorni)</Label>
            <Input
              type="number"
              min={0}
              step={1}
              value={form.dso_days_override}
              onChange={(e) => setForm((f) => ({ ...f, dso_days_override: e.target.value }))}
              className="mt-1"
              placeholder={`Default: ${defaultDsoDays}`}
            />
          </div>

          <div>
            <Label className="text-xs">PSO (giorni)</Label>
            <Input
              type="number"
              min={0}
              step={1}
              value={form.pso_days_override}
              onChange={(e) => setForm((f) => ({ ...f, pso_days_override: e.target.value }))}
              className="mt-1"
              placeholder={`Default: ${defaultPsoDays}`}
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
  const [rolesSynced, setRolesSynced] = useState(false)
  const [showCreate, setShowCreate] = useState(false)

  const [roleFilter, setRoleFilter] = useState<'all' | CounterpartyRole>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | CounterpartyStatus>('all')
  const [legalTypeFilter, setLegalTypeFilter] = useState<'all' | CounterpartyLegalType>('all')
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')

  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [invoiceDirectionFilter, setInvoiceDirectionFilter] = useState<'all' | 'in' | 'out'>('all')
  const [analyticsVatMode, setAnalyticsVatMode] = useState<AnalyticsVatMode>('excl')
  const [analyticsDateMode, setAnalyticsDateMode] = useState<AnalyticsDateMode>('invoice_date')
  const [analyticsPaymentAmountMode, setAnalyticsPaymentAmountMode] = useState<AnalyticsPaymentAmountMode>('net_paid')

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
    taxable_amount: number | null
    tax_amount: number | null
    payment_status: string
    counterparty_status_snapshot: string | null
  }>>([])
  const [linkedInstallments, setLinkedInstallments] = useState<CounterpartyInstallmentFlowRow[]>([])

  const [draft, setDraft] = useState<{
    name: string
    status: CounterpartyStatus
    legal_type: CounterpartyLegalType
    vat_mode: VatMode
    vat_value: string
    fiscal_code: string
    address: string
    dso_days_override: string
    pso_days_override: string
    notes: string
  } | null>(null)

  const reloadCounterparties = useCallback(async () => {
    if (!companyId) return

    setLoading(true)
    setError('')

    try {
      if (!rolesSynced) {
        const syncKey = `counterparty_roles_synced_at:${companyId}`
        const lastSyncedAt = Number(window.sessionStorage.getItem(syncKey) || 0)
        const sixHoursMs = 6 * 60 * 60 * 1000

        if (!lastSyncedAt || (Date.now() - lastSyncedAt) > sixHoursMs) {
          await syncCounterpartyRoles(companyId)
          window.sessionStorage.setItem(syncKey, String(Date.now()))
        }
        setRolesSynced(true)
      }

      const data = await loadCounterparties(companyId, {
        role: roleFilter,
        status: statusFilter,
        legalType: legalTypeFilter,
        query,
      })

      setCounterparties(data)
      setSelectedIds((prev) => {
        const allowed = new Set(data.map((cp) => cp.id))
        return new Set(Array.from(prev).filter((id) => allowed.has(id)))
      })

      if (focusedId && !data.some((cp) => cp.id === focusedId)) {
        setFocusedId(null)
      }
    } catch (e: any) {
      setError(e.message || 'Errore caricamento controparti')
    }

    setLoading(false)
  }, [companyId, roleFilter, statusFilter, legalTypeFilter, query, focusedId, rolesSynced])

  useEffect(() => {
    reloadCounterparties()
  }, [reloadCounterparties])

  useEffect(() => {
    setRolesSynced(false)
  }, [companyId])

  useEffect(() => {
    const t = window.setTimeout(() => {
      setQuery(queryInput.trim())
    }, 250)
    return () => window.clearTimeout(t)
  }, [queryInput])

  useEffect(() => {
    const paramId = searchParams.get('counterpartyId')
    if (!paramId || !counterparties.some((cp) => cp.id === paramId)) return

    setFocusedId(paramId)
    setSelectedIds((prev) => {
      if (prev.has(paramId)) return prev
      const next = new Set(prev)
      next.add(paramId)
      return next
    })
  }, [searchParams, counterparties])

  const focused = useMemo(
    () => counterparties.find((cp) => cp.id === focusedId) || null,
    [counterparties, focusedId],
  )

  useEffect(() => {
    if (!focused) {
      setDraft(null)
      return
    }

    const vat = parseVatForUi(focused.vat_number)
    setDraft({
      name: focused.name || '',
      status: focused.status,
      legal_type: focused.legal_type || 'altro',
      vat_mode: vat.mode,
      vat_value: vat.value,
      fiscal_code: focused.fiscal_code || '',
      address: focused.address || '',
      dso_days_override: focused.dso_days_override == null ? '' : String(focused.dso_days_override),
      pso_days_override: focused.pso_days_override == null ? '' : String(focused.pso_days_override),
      notes: focused.notes || '',
    })
  }, [focused])

  const analyticsTargetIds = useMemo(() => {
    if (selectedIds.size > 0) return Array.from(selectedIds)
    if (focusedId) return [focusedId]
    return []
  }, [selectedIds, focusedId])

  const analyticsTargetIdsSet = useMemo(() => new Set(analyticsTargetIds), [analyticsTargetIds])

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

  const reloadLinkedInstallments = useCallback(async () => {
    if (!companyId || analyticsTargetIds.length === 0 || analyticsDateMode !== 'payment_date') {
      setLinkedInstallments([])
      return
    }

    try {
      const rows = await loadInstallmentFlowsByCounterparty(companyId, analyticsTargetIds, {
        direction: invoiceDirectionFilter,
        onlyPaidDates: analyticsPaymentAmountMode === 'net_paid',
      })
      setLinkedInstallments(rows)
    } catch (e: any) {
      setError(e.message || 'Errore caricamento pagamenti scadenzario')
    }
  }, [companyId, analyticsTargetIds, analyticsDateMode, invoiceDirectionFilter, analyticsPaymentAmountMode])

  useEffect(() => {
    reloadLinkedInvoices()
  }, [reloadLinkedInvoices])

  useEffect(() => {
    reloadLinkedInstallments()
  }, [reloadLinkedInstallments])

  const analyticsSourceRows = useMemo(() => {
    if (analyticsDateMode === 'payment_date') {
      const inDateRange = (isoDate: string): boolean => {
        if (!isoDate) return false
        if (dateFrom && isoDate < dateFrom) return false
        if (dateTo && isoDate > dateTo) return false
        return true
      }

      return linkedInstallments
        .filter((row) => {
          if (analyticsPaymentAmountMode === 'net_paid') {
            const eventDate = String(row.last_payment_date || '')
            return inDateRange(eventDate) && Number(row.paid_amount || 0) > 0
          }
          const eventDate = String(row.last_payment_date || row.due_date || '')
          return inDateRange(eventDate)
        })
        .map((row) => {
          const sign = Number(row.amount_due || 0) < 0 ? -1 : 1
          const eventDate = analyticsPaymentAmountMode === 'net_paid'
            ? String(row.last_payment_date || '')
            : String(row.last_payment_date || row.due_date || '')
          const rawAmount = analyticsPaymentAmountMode === 'net_paid'
            ? Number(row.paid_amount || 0)
            : Math.abs(Number(row.amount_due || 0))
          return {
            counterparty_id: row.counterparty_id,
            direction: row.direction,
            date: eventDate,
            total_amount: Number((rawAmount * sign).toFixed(2)),
          }
        })
    }

    return linkedInvoices.map((r) => ({
      counterparty_id: r.counterparty_id,
      direction: r.direction,
      date: r.date,
      total_amount: analyticsAmountByVatMode(r, analyticsVatMode),
    }))
  }, [analyticsDateMode, linkedInstallments, analyticsPaymentAmountMode, linkedInvoices, analyticsVatMode])

  const analytics = useMemo(
    () => buildCounterpartyAnalytics(analyticsSourceRows, counterparties, {
      useSignedAmounts: analyticsDateMode === 'payment_date',
    }),
    [analyticsSourceRows, counterparties, analyticsDateMode],
  )

  const analyticsAmountLabel = useMemo(() => {
    if (analyticsDateMode === 'payment_date') {
      return analyticsPaymentAmountMode === 'net_paid'
        ? 'Pagamenti netti'
        : 'Totale rate saldate'
    }
    return analyticsVatMode === 'excl' ? 'IVA Excl' : 'IVA Incl'
  }, [analyticsDateMode, analyticsPaymentAmountMode, analyticsVatMode])

  const trendChartData = useMemo(
    () =>
      analytics.trend.map((item) => ({
        ...item,
        monthLabel: formatMonthKey(item.month),
      })),
    [analytics.trend],
  )

  const analyticsMonths = useMemo(() => {
    const months = new Set<string>()
    for (const row of analyticsSourceRows) {
      if (row.date) months.add(row.date.slice(0, 7))
    }
    return Array.from(months).sort((a, b) => a.localeCompare(b))
  }, [analyticsSourceRows])

  const analyticsTableRows = useMemo(() => {
    const cpMap = new Map(counterparties.map((cp) => [cp.id, cp]))
    const rowMap = new Map<string, {
      counterparty_id: string
      counterparty_name: string
      status: CounterpartyStatus
      activeAmount: number
      passiveAmount: number
      activeCount: number
      passiveCount: number
      totalAmount: number
      months: Record<string, number>
    }>()

    const ensureRow = (counterpartyId: string) => {
      const existing = rowMap.get(counterpartyId)
      if (existing) return existing

      const cp = cpMap.get(counterpartyId)
      const created = {
        counterparty_id: counterpartyId,
        counterparty_name: cp?.name || 'Controparte sconosciuta',
        status: (cp?.status || 'pending') as CounterpartyStatus,
        activeAmount: 0,
        passiveAmount: 0,
        activeCount: 0,
        passiveCount: 0,
        totalAmount: 0,
        months: Object.fromEntries(analyticsMonths.map((month) => [month, 0])),
      }
      rowMap.set(counterpartyId, created)
      return created
    }

    for (const id of analyticsTargetIds) {
      ensureRow(id)
    }

    for (const metricRow of analyticsSourceRows) {
      const amount = Number(metricRow.total_amount || 0)
      const month = metricRow.date?.slice(0, 7)
      const row = ensureRow(metricRow.counterparty_id)

      if (metricRow.direction === 'out') {
        row.activeAmount += amount
        row.activeCount += 1
      } else {
        row.passiveAmount += amount
        row.passiveCount += 1
      }

      row.totalAmount += amount
      if (month) {
        row.months[month] = Number(((row.months[month] || 0) + amount).toFixed(2))
      }
    }

    return Array.from(rowMap.values())
      .sort((a, b) => Math.abs(b.totalAmount) - Math.abs(a.totalAmount))
      .map((row) => ({
        ...row,
        activeAmount: Number(row.activeAmount.toFixed(2)),
        passiveAmount: Number(row.passiveAmount.toFixed(2)),
        totalAmount: Number(row.totalAmount.toFixed(2)),
      }))
  }, [counterparties, analyticsSourceRows, analyticsTargetIds, analyticsMonths])

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAllVisible = () => {
    setSelectedIds(new Set(counterparties.map((cp) => cp.id)))
  }

  const clearSelection = () => setSelectedIds(new Set())

  const allVisibleSelected = counterparties.length > 0 && counterparties.every((cp) => selectedIds.has(cp.id))

  const onRowClick = (id: string) => {
    toggleSelect(id)
  }

  const onRowDoubleClick = (id: string) => {
    setFocusedId(id)
    setSelectedIds(new Set([id]))
  }

  const saveFocused = async () => {
    if (!focused || !draft) return

    setSaving(true)
    setError('')

    try {
      await updateCounterparty(focused.id, {
        name: draft.name,
        status: draft.status,
        legal_type: draft.legal_type,
        vat_number: buildVatForSave(draft.vat_mode, draft.vat_value),
        fiscal_code: draft.fiscal_code || null,
        address: draft.address || null,
        dso_days_override: draft.dso_days_override === '' ? null : Number(draft.dso_days_override),
        pso_days_override: draft.pso_days_override === '' ? null : Number(draft.pso_days_override),
        notes: draft.notes || null,
      })
      await reloadCounterparties()
      await Promise.all([reloadLinkedInvoices(), reloadLinkedInstallments()])
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
      await Promise.all([reloadLinkedInvoices(), reloadLinkedInstallments()])
    } catch (e: any) {
      setError(e.message || 'Errore verifica')
    }

    setSaving(false)
  }

  const verifySelected = async () => {
    const ids = Array.from(selectedIds)
    if (!ids.length) return

    setSaving(true)
    setError('')

    let success = 0
    const failures: string[] = []

    for (const id of ids) {
      try {
        await verifyCounterparty(id)
        success += 1
      } catch (e: any) {
        const name = counterparties.find((cp) => cp.id === id)?.name || id
        failures.push(`${name}: ${e?.message || 'errore verifica'}`)
      }
    }

    await reloadCounterparties()
    await Promise.all([reloadLinkedInvoices(), reloadLinkedInstallments()])

    if (failures.length) {
      const preview = failures.slice(0, 3).join(' | ')
      setError(`Verificate ${success}/${ids.length}. ${preview}${failures.length > 3 ? ' | ...' : ''}`)
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
      await Promise.all([reloadLinkedInvoices(), reloadLinkedInstallments()])
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
                  value={queryInput}
                  onChange={(e) => setQueryInput(e.target.value)}
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

              <div className="text-[11px] text-gray-500">Clic: seleziona/deseleziona. Doppio clic: apre dettaglio.</div>
            </div>

            <div className="flex flex-wrap items-center gap-2 border rounded-lg p-2 bg-sky-50/40">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={allVisibleSelected ? clearSelection : selectAllVisible}
                disabled={counterparties.length === 0}
              >
                {allVisibleSelected ? 'Deseleziona tutti' : 'Seleziona tutti'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={verifySelected}
                disabled={selectedIds.size === 0 || saving}
              >
                <CheckCircle className="h-3.5 w-3.5 mr-1.5" />Verifica selezionate
              </Button>
              {selectedIds.size > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={clearSelection}
                >
                  Deseleziona selezionate
                </Button>
              )}
              <span className="text-xs text-sky-800 ml-auto">{selectedIds.size} selezionate</span>
            </div>

            <div className="flex-1 overflow-y-auto border rounded-lg divide-y">
              {loading ? (
                <div className="text-center py-8 text-sm text-gray-500">Caricamento...</div>
              ) : counterparties.length === 0 ? (
                <div className="text-center py-8 text-sm text-gray-500">Nessuna controparte trovata</div>
              ) : (
                counterparties.map((cp) => {
                  const selected = selectedIds.has(cp.id)
                  const focusedRow = focusedId === cp.id
                  return (
                    <div
                      key={cp.id}
                      className={`px-3 py-2 cursor-pointer transition-colors ${
                        selected ? 'bg-sky-100' : 'hover:bg-gray-50'
                      } ${focusedRow ? 'ring-1 ring-inset ring-sky-400' : ''}`}
                      onClick={() => onRowClick(cp.id)}
                      onDoubleClick={() => onRowDoubleClick(cp.id)}
                    >
                      <div className="flex items-start gap-2">
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
          </CardContent>
        </Card>

        <div className="space-y-4 min-w-0">
          {!focused || !draft ? (
            <Card>
              <CardContent className="p-10 text-center text-gray-500">Doppio clic su una controparte per aprire il dettaglio</CardContent>
            </Card>
          ) : (
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
                    <div className="mt-1 border rounded-md px-3 py-2 text-sm text-gray-700 bg-gray-50">
                      {ROLE_LABEL[focused.type]}
                    </div>
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
                    <div className="mt-1 flex gap-2">
                      <select
                        value={draft.vat_mode}
                        onChange={(e) => setDraft((d) => d ? ({ ...d, vat_mode: e.target.value as VatMode }) : d)}
                        className="w-20 border rounded-md px-2 py-2 text-sm"
                      >
                        <option value="IT">IT</option>
                        <option value="INT">Int.</option>
                      </select>
                      <Input
                        value={draft.vat_value}
                        onChange={(e) => setDraft((d) => d ? ({ ...d, vat_value: sanitizeVatInput(e.target.value) }) : d)}
                        className="flex-1"
                        placeholder={draft.vat_mode === 'IT' ? '12345678901' : 'FR123456789'}
                      />
                    </div>
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

                  <div>
                    <Label className="text-xs">DSO (giorni)</Label>
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      value={draft.dso_days_override}
                      onChange={(e) => setDraft((d) => d ? ({ ...d, dso_days_override: e.target.value }) : d)}
                      className="mt-1"
                      placeholder={`Default: ${company?.default_dso_days ?? 30}`}
                    />
                  </div>

                  <div>
                    <Label className="text-xs">PSO (giorni)</Label>
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      value={draft.pso_days_override}
                      onChange={(e) => setDraft((d) => d ? ({ ...d, pso_days_override: e.target.value }) : d)}
                      className="mt-1"
                      placeholder={`Default: ${company?.default_pso_days ?? 30}`}
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
          )}

          <Card className="min-w-0">
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
                {(dateFrom || dateTo) && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={() => { setDateFrom(''); setDateTo('') }}
                  >
                    Tutto periodo
                  </Button>
                )}
                <select
                  value={invoiceDirectionFilter}
                  onChange={(e) => setInvoiceDirectionFilter(e.target.value as 'all' | 'in' | 'out')}
                  className="border rounded-md px-2 py-1 text-xs"
                >
                  <option value="all">Attive + Passive</option>
                  <option value="out">Solo Attive</option>
                  <option value="in">Solo Passive</option>
                </select>
                <select
                  value={analyticsDateMode}
                  onChange={(e) => setAnalyticsDateMode(e.target.value as AnalyticsDateMode)}
                  className="border rounded-md px-2 py-1 text-xs"
                >
                  <option value="invoice_date">Valori per data fattura</option>
                  <option value="payment_date">Valori per data pagamento (scadenzario)</option>
                </select>
                {analyticsDateMode === 'payment_date' ? (
                  <select
                    value={analyticsPaymentAmountMode}
                    onChange={(e) => setAnalyticsPaymentAmountMode(e.target.value as AnalyticsPaymentAmountMode)}
                    className="border rounded-md px-2 py-1 text-xs"
                  >
                    <option value="net_paid">Importi netti pagati/incassati</option>
                    <option value="total_installment">Importi totali rate (aperte + saldate)</option>
                  </select>
                ) : (
                <select
                  value={analyticsVatMode}
                  onChange={(e) => setAnalyticsVatMode(e.target.value as AnalyticsVatMode)}
                  className="border rounded-md px-2 py-1 text-xs"
                >
                  <option value="excl">IVA Excl</option>
                  <option value="incl">IVA Incl</option>
                </select>
                )}
                <span className="text-xs text-gray-500 ml-auto">Target: {analyticsTargetIds.length || 0} controparti</span>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
                <div className="p-2 rounded border bg-emerald-50">
                  <p className="text-[10px] text-emerald-700 uppercase">Totale attive ({analyticsAmountLabel})</p>
                  <p className="text-sm font-bold text-emerald-700">{fmtEur(analytics.totalActiveAmount)}</p>
                </div>
                <div className="p-2 rounded border bg-red-50">
                  <p className="text-[10px] text-red-700 uppercase">Totale passive ({analyticsAmountLabel})</p>
                  <p className="text-sm font-bold text-red-700">{fmtEur(analytics.totalPassiveAmount)}</p>
                </div>
                <div className="p-2 rounded border bg-blue-50">
                  <p className="text-[10px] text-blue-700 uppercase">Saldo netto ({analyticsAmountLabel})</p>
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

              <div className="h-64 border rounded-lg p-2 overflow-hidden">
                {trendChartData.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-sm text-gray-500">Nessun dato nel periodo</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={trendChartData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="monthLabel" />
                      <YAxis
                        width={72}
                        tickMargin={6}
                        tick={{ fontSize: 11 }}
                        tickFormatter={(v: any) => formatCompactNumber(Number(v || 0))}
                      />
                      <Tooltip formatter={(v: any) => fmtEur(Number(v || 0))} />
                      <Legend />
                      <Bar dataKey="activeAmount" name="Attive" stackId="a" fill="#059669" />
                      <Bar dataKey="passiveAmount" name="Passive" stackId="a" fill="#dc2626" />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>

              <div className="border rounded-lg overflow-x-auto">
                <table className="w-full text-xs min-w-[920px]">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left px-3 py-2">Controparte</th>
                      <th className="text-right px-3 py-2">Attive</th>
                      <th className="text-right px-3 py-2">Passive</th>
                      <th className="text-right px-3 py-2">Totale</th>
                      {analyticsMonths.map((month) => (
                        <th key={month} className="text-right px-3 py-2">{formatMonthKey(month)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {analyticsTableRows.length === 0 ? (
                      <tr>
                        <td colSpan={4 + analyticsMonths.length} className="text-center py-4 text-gray-500">Nessun dato</td>
                      </tr>
                    ) : (
                      analyticsTableRows.map((row) => (
                        <tr key={row.counterparty_id} className="border-t">
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <span>{row.counterparty_name}</span>
                              {row.status !== 'verified' && (
                                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${STATUS_BADGE[row.status]}`}>
                                  {STATUS_LABEL[row.status]}
                                </span>
                              )}
                              {!analyticsTargetIdsSet.has(row.counterparty_id) && (
                                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                                  fuori filtro
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right text-emerald-700 font-medium">{fmtEurOrDash(row.activeAmount)}</td>
                          <td className="px-3 py-2 text-right text-red-700 font-medium">{fmtEurOrDash(row.passiveAmount)}</td>
                          <td className="px-3 py-2 text-right font-semibold">{fmtEurOrDash(row.totalAmount)}</td>
                          {analyticsMonths.map((month) => (
                            <td key={`${row.counterparty_id}-${month}`} className="px-3 py-2 text-right">
                              {fmtEurOrDash(row.months[month] || 0)}
                            </td>
                          ))}
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
              {!analyticsTargetIds.length ? (
                <div className="text-sm text-gray-500 py-6 text-center">Seleziona almeno una controparte dalla lista</div>
              ) : (
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
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {companyId && (
        <CounterpartyCreateModal
          open={showCreate}
          onClose={() => setShowCreate(false)}
          onCreated={reloadCounterparties}
          companyId={companyId}
          defaultDsoDays={company?.default_dso_days ?? 30}
          defaultPsoDays={company?.default_pso_days ?? 30}
        />
      )}
    </div>
  )
}
