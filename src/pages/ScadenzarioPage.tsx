import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CalendarClock, Receipt, ArrowDownLeft, ArrowUpRight, Search, Filter } from 'lucide-react'
import { useCompany } from '@/hooks/useCompany'
import { supabase } from '@/integrations/supabase/client'
import { fmtDate, fmtEur } from '@/lib/utils'
import {
  buildAging,
  buildScadenzarioKpis,
  listScadenzarioRows,
  rebuildInstallmentsFull,
  recordInstallmentPayment,
  touchOverdueInstallments,
  type AgingResult,
  type InstallmentStatus,
  type ScadenzarioFilters,
  type ScadenzarioKpis,
  type ScadenzarioRow,
} from '@/lib/scadenzario'

const STATUS_OPTIONS: Array<{ value: InstallmentStatus; label: string }> = [
  { value: 'pending', label: 'Da incassare/pagare' },
  { value: 'overdue', label: 'Scaduto' },
  { value: 'partial', label: 'Parziale' },
  { value: 'paid', label: 'Pagato/Incassato' },
]

const PERIOD_OPTIONS: Array<{ value: ScadenzarioFilters['periodPreset']; label: string }> = [
  { value: 'all', label: 'Tutto periodo' },
  { value: 'next_7', label: 'Prossimi 7 giorni' },
  { value: 'next_30', label: 'Prossimi 30 giorni' },
  { value: 'next_90', label: 'Prossimi 90 giorni' },
  { value: 'this_month', label: 'Questo mese' },
  { value: 'next_month', label: 'Prossimo mese' },
  { value: 'custom', label: 'Range personalizzato' },
]

function rowGroup(dueDate: string, today: string): 'overdue' | 'today' | 'future' {
  if (dueDate < today) return 'overdue'
  if (dueDate === today) return 'today'
  return 'future'
}

function rowGroupLabel(group: 'overdue' | 'today' | 'future'): string {
  if (group === 'overdue') return 'Scadute'
  if (group === 'today') return 'Oggi'
  return 'Future'
}

function rowStatusBadge(status: InstallmentStatus): string {
  if (status === 'overdue') return 'bg-red-100 text-red-700'
  if (status === 'paid') return 'bg-emerald-100 text-emerald-700'
  if (status === 'partial') return 'bg-amber-100 text-amber-700'
  return 'bg-gray-100 text-gray-700'
}

function rowTypeBadge(type: ScadenzarioRow['type']): string {
  if (type === 'incasso') return 'bg-emerald-100 text-emerald-700'
  if (type === 'pagamento') return 'bg-red-100 text-red-700'
  return 'bg-amber-100 text-amber-700'
}

function rowTypeLabel(type: ScadenzarioRow['type']): string {
  if (type === 'incasso') return 'Incasso'
  if (type === 'pagamento') return 'Pagamento'
  return 'IVA'
}

function rowTypeIcon(type: ScadenzarioRow['type']) {
  if (type === 'incasso') return <ArrowDownLeft className="h-3.5 w-3.5" />
  if (type === 'pagamento') return <ArrowUpRight className="h-3.5 w-3.5" />
  return <Receipt className="h-3.5 w-3.5" />
}

function sortArrow(currentBy: string, currentDir: 'asc' | 'desc', thisBy: string): string {
  if (currentBy !== thisBy) return ''
  return currentDir === 'asc' ? ' ↑' : ' ↓'
}

function buildReminderText(row: ScadenzarioRow): string {
  return [
    `Gentile ${row.counterparty_name},`,
    '',
    `ti ricordiamo la scadenza di ${row.reference} del ${fmtDate(row.due_date)} per un importo residuo di ${fmtEur(row.remaining_amount)}.`,
    'Ti chiediamo gentilmente di procedere al saldo quanto prima e di inviarci conferma.',
    '',
    'Grazie,',
    'FinFlow',
  ].join('\n')
}

function moneyColor(type: ScadenzarioRow['type']): string {
  return type === 'incasso' ? 'text-emerald-700' : 'text-red-700'
}

export default function ScadenzarioPage() {
  const { company } = useCompany()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const [activeTab, setActiveTab] = useState<'all' | 'incassi' | 'pagamenti'>('all')
  const [periodPreset, setPeriodPreset] = useState<ScadenzarioFilters['periodPreset']>('next_30')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [statusFilters, setStatusFilters] = useState<Set<InstallmentStatus>>(new Set(['pending', 'overdue', 'partial']))
  const [counterpartyId, setCounterpartyId] = useState<string>('')
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState<ScadenzarioFilters['sortBy']>('due_date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [backfillTried, setBackfillTried] = useState(false)
  const [rows, setRows] = useState<ScadenzarioRow[]>([])
  const [kpis, setKpis] = useState<ScadenzarioKpis>({
    da_incassare: 0,
    da_pagare: 0,
    scaduto_clienti: 0,
    scaduto_fornitori: 0,
    eventi_iva: 0,
  })
  const [aging, setAging] = useState<AgingResult | null>(null)
  const [showAging, setShowAging] = useState(true)

  const [counterparties, setCounterparties] = useState<Array<{ id: string; name: string; email: string | null }>>([])

  const [paymentModal, setPaymentModal] = useState<{
    open: boolean
    row: ScadenzarioRow | null
    paymentDate: string
    amount: string
    saving: boolean
    error: string | null
  }>({
    open: false,
    row: null,
    paymentDate: new Date().toISOString().slice(0, 10),
    amount: '0',
    saving: false,
    error: null,
  })

  const [reminderModal, setReminderModal] = useState<{
    open: boolean
    row: ScadenzarioRow | null
    text: string
  }>({
    open: false,
    row: null,
    text: '',
  })

  const counterpartyMap = useMemo(
    () => new Map(counterparties.map((cp) => [cp.id, cp])),
    [counterparties],
  )

  useEffect(() => {
    setBackfillTried(false)
  }, [company?.id])

  useEffect(() => {
    const tab = String(searchParams.get('tab') || '').toLowerCase()
    if (tab === 'tutte') setActiveTab('all')
    if (tab === 'all') setActiveTab('all')
    if (tab === 'incassi') setActiveTab('incassi')
    if (tab === 'pagamenti') setActiveTab('pagamenti')

    const period = String(searchParams.get('period') || '').toLowerCase()
    if (period === 'next_7') setPeriodPreset('next_7')
    if (period === 'next_30') setPeriodPreset('next_30')
    if (period === 'next_90') setPeriodPreset('next_90')
    if (period === 'this_month') setPeriodPreset('this_month')
    if (period === 'next_month') setPeriodPreset('next_month')
    if (period === 'custom') setPeriodPreset('custom')
    if (period === 'all') setPeriodPreset('all')
  }, [searchParams])

  const filters = useMemo<ScadenzarioFilters>(() => ({
    mode: activeTab,
    periodPreset,
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
    statuses: Array.from(statusFilters),
    counterpartyId: counterpartyId || null,
    query,
    sortBy,
    sortDir,
  }), [activeTab, periodPreset, dateFrom, dateTo, statusFilters, counterpartyId, query, sortBy, sortDir])

  const loadCounterparties = useCallback(async () => {
    if (!company?.id) return
    const { data, error: cpErr } = await supabase
      .from('counterparties')
      .select('id, name, email')
      .eq('company_id', company.id)
      .order('name', { ascending: true })

    if (cpErr) throw new Error(cpErr.message)
    setCounterparties((data || []) as Array<{ id: string; name: string; email: string | null }>)
  }, [company?.id])

  const loadRows = useCallback(async () => {
    if (!company?.id) {
      setRows([])
      setKpis({ da_incassare: 0, da_pagare: 0, scaduto_clienti: 0, scaduto_fornitori: 0, eventi_iva: 0 })
      setAging(null)
      return
    }

    setLoading(true)
    setError(null)

    try {
      await touchOverdueInstallments(company.id)

      if (!backfillTried) {
        const [installmentsCountRes, invoicesCountRes] = await Promise.all([
          supabase
            .from('invoice_installments')
            .select('id', { count: 'exact', head: true })
            .eq('company_id', company.id),
          supabase
            .from('invoices')
            .select('id', { count: 'exact', head: true })
            .eq('company_id', company.id),
        ])

        if (installmentsCountRes.error) throw new Error(installmentsCountRes.error.message)
        if (invoicesCountRes.error) throw new Error(invoicesCountRes.error.message)

        const installmentsCount = Number(installmentsCountRes.count || 0)
        const invoicesCount = Number(invoicesCountRes.count || 0)
        if (installmentsCount === 0 && invoicesCount > 0) {
          await rebuildInstallmentsFull(company.id)
        }

        setBackfillTried(true)
      }

      const [scadenzarioRows, nextKpis] = await Promise.all([
        listScadenzarioRows(company.id, filters),
        buildScadenzarioKpis(company.id, 30),
      ])

      setRows(scadenzarioRows)
      setKpis(nextKpis)

      if (activeTab === 'incassi' || activeTab === 'pagamenti') {
        const nextAging = await buildAging(company.id, activeTab, {
          query,
          counterpartyId: counterpartyId || null,
        })
        setAging(nextAging)
      } else {
        setAging(null)
      }
    } catch (e: any) {
      setError(e.message || 'Errore caricamento scadenzario')
    } finally {
      setLoading(false)
    }
  }, [company?.id, filters, activeTab, query, counterpartyId, backfillTried])

  useEffect(() => {
    loadRows()
  }, [loadRows])

  useEffect(() => {
    loadCounterparties()
  }, [loadCounterparties])

  const toggleStatusFilter = (status: InstallmentStatus) => {
    setStatusFilters((prev) => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
  }

  const clearFilters = () => {
    setPeriodPreset('next_30')
    setDateFrom('')
    setDateTo('')
    setStatusFilters(new Set(['pending', 'overdue', 'partial']))
    setCounterpartyId('')
    setQuery('')
    setSortBy('due_date')
    setSortDir('asc')
  }

  const today = new Date().toISOString().slice(0, 10)

  const openPaymentModal = (row: ScadenzarioRow) => {
    setPaymentModal({
      open: true,
      row,
      paymentDate: today,
      amount: String(row.remaining_amount || row.amount || 0),
      saving: false,
      error: null,
    })
  }

  const submitPayment = async () => {
    if (!paymentModal.row || paymentModal.row.kind !== 'installment') return

    const amount = Number(paymentModal.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      setPaymentModal((prev) => ({ ...prev, error: 'Importo pagamento non valido' }))
      return
    }

    setPaymentModal((prev) => ({ ...prev, saving: true, error: null }))
    try {
      await recordInstallmentPayment({
        installmentId: paymentModal.row.id,
        paymentDate: paymentModal.paymentDate,
        amount,
      })
      setPaymentModal({
        open: false,
        row: null,
        paymentDate: today,
        amount: '0',
        saving: false,
        error: null,
      })
      await loadRows()
    } catch (e: any) {
      setPaymentModal((prev) => ({ ...prev, saving: false, error: e.message || 'Errore registrazione pagamento' }))
    }
  }

  const openReminder = (row: ScadenzarioRow) => {
    setReminderModal({
      open: true,
      row,
      text: buildReminderText(row),
    })
  }

  const copyReminder = async () => {
    if (!reminderModal.text) return
    try {
      await navigator.clipboard.writeText(reminderModal.text)
    } catch {
      // fallback silent: user can still copy manually
    }
  }

  const openReminderMail = () => {
    if (!reminderModal.row) return
    const cp = reminderModal.row.counterparty_id ? counterpartyMap.get(reminderModal.row.counterparty_id) : null
    const subject = encodeURIComponent(`Sollecito pagamento ${reminderModal.row.reference}`)
    const body = encodeURIComponent(reminderModal.text)
    const to = encodeURIComponent(cp?.email || '')
    window.open(`mailto:${to}?subject=${subject}&body=${body}`, '_blank')
  }

  const onSort = (column: NonNullable<ScadenzarioFilters['sortBy']>) => {
    if (sortBy === column) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortBy(column)
    setSortDir('asc')
  }

  const groupedRows = useMemo(() => {
    const out: Array<{ key: string; row: ScadenzarioRow; separator?: string }> = []
    let prevGroup: 'overdue' | 'today' | 'future' | null = null

    for (const row of rows) {
      const group = rowGroup(row.due_date, today)
      const separator = sortBy === 'due_date' && group !== prevGroup ? rowGroupLabel(group) : undefined
      out.push({ key: `${row.kind}-${row.id}`, row, separator })
      prevGroup = group
    }

    return out
  }, [rows, today, sortBy])

  const canShowAging = activeTab === 'incassi' || activeTab === 'pagamenti'

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Scadenzario</h1>
        <p className="text-muted-foreground text-sm mt-1">Entrate/Uscite aziendali: rate fatture e liquidazioni IVA</p>
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs uppercase text-emerald-700">Da incassare (30gg)</p>
            <p className="text-2xl font-bold text-emerald-800 mt-1">{fmtEur(kpis.da_incassare)}</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <p className="text-xs uppercase text-red-700">Da pagare (30gg)</p>
            <p className="text-2xl font-bold text-red-800 mt-1">{fmtEur(kpis.da_pagare)}</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <p className="text-xs uppercase text-amber-700">Scaduto clienti</p>
            <p className="text-2xl font-bold text-amber-800 mt-1">{fmtEur(kpis.scaduto_clienti)}</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <p className="text-xs uppercase text-orange-700">Scaduto fornitori</p>
            <p className="text-2xl font-bold text-orange-800 mt-1">{fmtEur(kpis.scaduto_fornitori)}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarClock className="h-4 w-4" /> Timeline scadenze
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'all' | 'incassi' | 'pagamenti')}>
            <TabsList>
              <TabsTrigger value="all">Tutte</TabsTrigger>
              <TabsTrigger value="incassi">Incassi</TabsTrigger>
              <TabsTrigger value="pagamenti">Pagamenti</TabsTrigger>
            </TabsList>
            <TabsContent value={activeTab} className="mt-4 space-y-4">
              <div className="border rounded-lg p-3 bg-gray-50/50 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
                  <div>
                    <Label className="text-xs">Periodo</Label>
                    <select
                      value={periodPreset}
                      onChange={(e) => setPeriodPreset(e.target.value as ScadenzarioFilters['periodPreset'])}
                      className="w-full mt-1 border rounded-md px-2 py-2 text-sm"
                    >
                      {PERIOD_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <Label className="text-xs">Stato</Label>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {STATUS_OPTIONS.map((option) => {
                        const selected = statusFilters.has(option.value)
                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => toggleStatusFilter(option.value)}
                            className={`px-2 py-1 text-[11px] rounded-md border ${selected ? 'bg-sky-100 border-sky-300 text-sky-700' : 'bg-white border-gray-200 text-gray-600'}`}
                          >
                            {option.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div>
                    <Label className="text-xs">Controparte</Label>
                    <select
                      value={counterpartyId}
                      onChange={(e) => setCounterpartyId(e.target.value)}
                      className="w-full mt-1 border rounded-md px-2 py-2 text-sm"
                    >
                      <option value="">Tutte</option>
                      {counterparties.map((cp) => (
                        <option key={cp.id} value={cp.id}>{cp.name}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <Label className="text-xs">Cerca</Label>
                    <div className="mt-1 relative">
                      <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-gray-400" />
                      <Input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Numero fattura o controparte"
                        className="pl-7"
                      />
                    </div>
                  </div>

                  <div className="flex items-end">
                    <Button variant="outline" className="w-full" onClick={clearFilters}>
                      <Filter className="h-3.5 w-3.5 mr-1.5" /> Reset filtri
                    </Button>
                  </div>
                </div>

                {periodPreset === 'custom' && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Dal</Label>
                      <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="mt-1" />
                    </div>
                    <div>
                      <Label className="text-xs">Al</Label>
                      <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="mt-1" />
                    </div>
                  </div>
                )}
              </div>

              <div className="overflow-x-auto border rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left px-3 py-2 cursor-pointer" onClick={() => onSort('due_date')}>Data scadenza{sortArrow(sortBy || '', sortDir, 'due_date')}</th>
                      <th className="text-left px-3 py-2 cursor-pointer" onClick={() => onSort('type')}>Tipo{sortArrow(sortBy || '', sortDir, 'type')}</th>
                      <th className="text-left px-3 py-2 cursor-pointer" onClick={() => onSort('counterparty')}>Controparte{sortArrow(sortBy || '', sortDir, 'counterparty')}</th>
                      <th className="text-left px-3 py-2 cursor-pointer" onClick={() => onSort('reference')}>Riferimento{sortArrow(sortBy || '', sortDir, 'reference')}</th>
                      <th className="text-left px-3 py-2">Rata</th>
                      <th className="text-right px-3 py-2 cursor-pointer" onClick={() => onSort('amount')}>Importo{sortArrow(sortBy || '', sortDir, 'amount')}</th>
                      <th className="text-left px-3 py-2 cursor-pointer" onClick={() => onSort('status')}>Stato{sortArrow(sortBy || '', sortDir, 'status')}</th>
                      <th className="text-right px-3 py-2 cursor-pointer" onClick={() => onSort('days')}>Giorni{sortArrow(sortBy || '', sortDir, 'days')}</th>
                      <th className="text-right px-3 py-2">Azioni</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr>
                        <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">Caricamento scadenze...</td>
                      </tr>
                    ) : groupedRows.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">Nessuna scadenza trovata con i filtri correnti.</td>
                      </tr>
                    ) : (
                      groupedRows.map(({ key, row, separator }) => {
                        const isToday = row.due_date === today
                        const isOverdue = row.status === 'overdue' && row.remaining_amount > 0

                        return (
                          <Fragment key={key}>
                            {separator && (
                              <tr>
                                <td colSpan={9} className="px-3 py-2 text-xs font-semibold uppercase text-gray-500 bg-gray-100/70 border-y">
                                  {separator}
                                </td>
                              </tr>
                            )}
                            <tr
                              onDoubleClick={() => navigate(row.reference_link)}
                              className={`border-t cursor-pointer ${isOverdue ? 'bg-red-50/60' : isToday ? 'bg-amber-50/70' : ''}`}
                            >
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-1.5">
                                  <span>{fmtDate(row.due_date)}</span>
                                  {row.is_estimated && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700" title="Scadenza stimata">
                                      stimata
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="px-3 py-2">
                                <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full font-medium ${rowTypeBadge(row.type)}`}>
                                  {rowTypeIcon(row.type)}
                                  {rowTypeLabel(row.type)}
                                </span>
                              </td>
                              <td className="px-3 py-2">
                                {row.counterparty_link ? (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      navigate(row.counterparty_link || '/controparti')
                                    }}
                                    className="text-left text-blue-700 hover:underline"
                                  >
                                    {row.counterparty_name}
                                  </button>
                                ) : (
                                  <span className="text-gray-500">{row.counterparty_name}</span>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    navigate(row.reference_link)
                                  }}
                                  className="text-left hover:underline"
                                >
                                  {row.reference}
                                </button>
                              </td>
                              <td className="px-3 py-2 text-gray-600">{row.installment_label || ''}</td>
                              <td className={`px-3 py-2 text-right font-semibold ${moneyColor(row.type)}`}>{fmtEur(row.amount)}</td>
                              <td className="px-3 py-2">
                                <span className={`text-[11px] px-2 py-1 rounded-full font-medium ${rowStatusBadge(row.status)}`}>
                                  {row.status_label}
                                </span>
                              </td>
                              <td className={`px-3 py-2 text-right font-medium ${row.days > 0 ? 'text-red-700' : row.days < 0 ? 'text-emerald-700' : 'text-amber-700'}`}>
                                {row.days > 0 ? `+${row.days}` : row.days}
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex justify-end gap-2">
                                  {row.kind === 'installment' && row.status !== 'paid' && (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        openPaymentModal(row)
                                      }}
                                    >
                                      {row.type === 'incasso' ? 'Segna incassato' : 'Segna pagato'}
                                    </Button>
                                  )}
                                  {row.kind === 'installment' && row.type === 'incasso' && row.status === 'overdue' && (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        openReminder(row)
                                      }}
                                    >
                                      Sollecita
                                    </Button>
                                  )}
                                  {row.kind === 'vat' && (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        navigate(row.reference_link)
                                      }}
                                    >
                                      Apri IVA
                                    </Button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          </Fragment>
                        )
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {canShowAging && aging && (
                <Card>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">
                        {activeTab === 'incassi' ? 'Analisi crediti per anzianita' : 'Analisi debiti per anzianita'}
                      </CardTitle>
                      <Button variant="outline" size="sm" onClick={() => setShowAging((v) => !v)}>
                        {showAging ? 'Nascondi' : 'Mostra'}
                      </Button>
                    </div>
                  </CardHeader>
                  {showAging && (
                    <CardContent className="space-y-3">
                      <div className="overflow-x-auto border rounded-lg">
                        <table className="w-full text-sm">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="text-left px-3 py-2">{activeTab === 'incassi' ? 'Cliente' : 'Fornitore'}</th>
                              <th className="text-right px-3 py-2">Totale</th>
                              <th className="text-right px-3 py-2">Corrente</th>
                              <th className="text-right px-3 py-2">1-30 gg</th>
                              <th className="text-right px-3 py-2">31-60 gg</th>
                              <th className="text-right px-3 py-2">61-90 gg</th>
                              <th className="text-right px-3 py-2">90+ gg</th>
                            </tr>
                          </thead>
                          <tbody>
                            {aging.rows.length === 0 ? (
                              <tr>
                                <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">Nessun dato aging disponibile.</td>
                              </tr>
                            ) : (
                              aging.rows.map((row) => (
                                <tr key={`${row.counterparty_id || row.counterparty_name}`} className="border-t">
                                  <td className="px-3 py-2">
                                    {row.counterparty_id ? (
                                      <button
                                        type="button"
                                        onClick={() => navigate(`/controparti?counterpartyId=${row.counterparty_id}`)}
                                        className="text-blue-700 hover:underline"
                                      >
                                        {row.counterparty_name}
                                      </button>
                                    ) : (
                                      <span>{row.counterparty_name}</span>
                                    )}
                                  </td>
                                  <td className="px-3 py-2 text-right font-semibold">{fmtEur(row.total)}</td>
                                  <td className="px-3 py-2 text-right">{fmtEur(row.current)}</td>
                                  <td className="px-3 py-2 text-right">{fmtEur(row.bucket_1_30)}</td>
                                  <td className="px-3 py-2 text-right">{fmtEur(row.bucket_31_60)}</td>
                                  <td className="px-3 py-2 text-right">{fmtEur(row.bucket_61_90)}</td>
                                  <td className="px-3 py-2 text-right">{fmtEur(row.bucket_90_plus)}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>

                      <div className="text-sm text-gray-700">
                        KPI {activeTab === 'incassi' ? 'DSO' : 'DPO'} stimato: <span className="font-semibold">{aging.kpi_days.toLocaleString('it-IT', { maximumFractionDigits: 1 })} giorni</span>
                      </div>
                    </CardContent>
                  )}
                </Card>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {paymentModal.open && paymentModal.row && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setPaymentModal((prev) => ({ ...prev, open: false }))}>
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold mb-3">{paymentModal.row.type === 'incasso' ? 'Registra incasso' : 'Registra pagamento'}</h3>
            <p className="text-sm text-gray-600 mb-4">{paymentModal.row.reference} - residuo {fmtEur(paymentModal.row.remaining_amount)}</p>
            <div className="space-y-3">
              <div>
                <Label className="text-xs">Data</Label>
                <Input
                  type="date"
                  value={paymentModal.paymentDate}
                  onChange={(e) => setPaymentModal((prev) => ({ ...prev, paymentDate: e.target.value }))}
                  className="mt-1"
                />
              </div>
              <div>
                <Label className="text-xs">Importo</Label>
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  value={paymentModal.amount}
                  onChange={(e) => setPaymentModal((prev) => ({ ...prev, amount: e.target.value }))}
                  className="mt-1"
                />
              </div>
              {paymentModal.error && <p className="text-xs text-red-600">{paymentModal.error}</p>}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setPaymentModal((prev) => ({ ...prev, open: false }))}>Annulla</Button>
              <Button onClick={submitPayment} disabled={paymentModal.saving}>
                {paymentModal.saving ? 'Salvataggio...' : 'Conferma'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {reminderModal.open && reminderModal.row && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setReminderModal({ open: false, row: null, text: '' })}>
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-2xl w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold mb-3">Sollecito pagamento</h3>
            <p className="text-sm text-gray-600 mb-2">{reminderModal.row.reference} - {reminderModal.row.counterparty_name}</p>
            <textarea
              value={reminderModal.text}
              onChange={(e) => setReminderModal((prev) => ({ ...prev, text: e.target.value }))}
              className="w-full min-h-[220px] border rounded-md px-3 py-2 text-sm"
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={copyReminder}>Copia testo</Button>
              <Button variant="outline" onClick={openReminderMail}>Apri in email</Button>
              <Button onClick={() => setReminderModal({ open: false, row: null, text: '' })}>Chiudi</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
