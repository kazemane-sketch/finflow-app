import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Receipt, Calculator, CalendarClock, RefreshCw, ShieldCheck } from 'lucide-react'
import { useCompany } from '@/hooks/useCompany'
import {
  confirmVatBackfill,
  confirmVatPayment,
  createManualVatEntry,
  deleteManualVatEntry,
  formatVatPeriodLabel,
  getCompanyFiscalRegime,
  getCompanyRole,
  getFirstInvoiceDate,
  getVatCurrentSummary,
  getVatProfile,
  listVatBreakdown,
  listManualVatEntries,
  listVatPaymentMatches,
  listVatPeriodSnapshotEntries,
  listVatPeriodsLight,
  suggestVatMatches,
  syncVatEngine,
  upsertVatProfile,
  type CompanyRole,
  type ManualVatEntryInput,
  type VatEntry,
  type VatBreakdownRow,
  type VatPaymentMatch,
  type VatPeriod,
  type VatPeriodSnapshotEntry,
  type VatProfile,
  type VatProfileInput,
} from '@/lib/vat'
import { fmtDate, fmtEur } from '@/lib/utils'

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    draft: 'Bozza',
    to_pay: 'Da versare',
    paid: 'Versato',
    credit: 'Credito',
    under_threshold: '< 100€ (riporto)',
    overdue: 'Scaduto',
  }
  return map[status] || status
}

function statusClass(status: string): string {
  const map: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-700',
    to_pay: 'bg-amber-100 text-amber-700',
    paid: 'bg-emerald-100 text-emerald-700',
    credit: 'bg-blue-100 text-blue-700',
    under_threshold: 'bg-purple-100 text-purple-700',
    overdue: 'bg-red-100 text-red-700',
  }
  return map[status] || 'bg-gray-100 text-gray-700'
}

function getDaysToDue(dueDate: string): number {
  const ms = new Date(`${dueDate}T00:00:00`).getTime() - new Date().setHours(0, 0, 0, 0)
  return Math.round(ms / (1000 * 60 * 60 * 24))
}

function emptyProfileInput(startDate: string): VatProfileInput {
  return {
    liquidation_regime: 'monthly',
    activity_type: 'services',
    start_date: startDate,
    opening_vat_credit: 0,
    opening_vat_debit: 0,
    deferred_mode: 'on_verified_payment',
    acconto_method: 'historical',
    acconto_override_amount: null,
    commercialista_confirmed: false,
  }
}

function fromProfile(profile: VatProfile): VatProfileInput {
  return {
    liquidation_regime: profile.liquidation_regime,
    activity_type: profile.activity_type,
    start_date: profile.start_date,
    opening_vat_credit: Number(profile.opening_vat_credit || 0),
    opening_vat_debit: Number(profile.opening_vat_debit || 0),
    deferred_mode: profile.deferred_mode,
    acconto_method: profile.acconto_method,
    acconto_override_amount: profile.acconto_override_amount,
    commercialista_confirmed: Boolean(profile.commercialista_confirmed),
  }
}

function isEditor(role: CompanyRole | null): boolean {
  return role === 'owner' || role === 'admin'
}

function isTimeoutVatError(message: string | null | undefined): boolean {
  return /statement timeout|canceling statement due to statement timeout/i.test(String(message || ''))
}

export default function IvaPage() {
  const { company } = useCompany()

  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [savingProfile, setSavingProfile] = useState(false)

  const [role, setRole] = useState<CompanyRole | null>(null)
  const [fiscalRegime, setFiscalRegime] = useState<string | null>(null)
  const [profile, setProfile] = useState<VatProfile | null>(null)
  const [profileForm, setProfileForm] = useState<VatProfileInput | null>(null)

  const [periods, setPeriods] = useState<VatPeriod[]>([])
  const [currentPeriodId, setCurrentPeriodId] = useState<string | null>(null)
  const [breakdown, setBreakdown] = useState<VatBreakdownRow[]>([])
  const [snapshotEntries, setSnapshotEntries] = useState<VatPeriodSnapshotEntry[]>([])
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [snapshotPeriodId, setSnapshotPeriodId] = useState<string | null>(null)
  const [manualEntries, setManualEntries] = useState<VatEntry[]>([])
  const [matchesByPeriod, setMatchesByPeriod] = useState<Record<string, VatPaymentMatch[]>>({})
  const [manualForm, setManualForm] = useState<ManualVatEntryInput>({
    effective_date: new Date().toISOString().slice(0, 10),
    taxable_amount: 0,
    vat_amount: 0,
    vat_debit_amount: 0,
    vat_credit_amount: 0,
    vat_rate: 0,
    vat_nature: null,
    esigibilita: 'I',
    manual_note: '',
  })

  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const canEdit = useMemo(() => isEditor(role), [role])
  const backfillPending = useMemo(() => Boolean(profile && !profile.backfill_confirmed), [profile])
  const hasRegularPeriods = useMemo(() => periods.some((p) => p.period_type === 'regular'), [periods])
  const backfillPreviewInconsistent = useMemo(() => {
    const invoicesCount = Number(profile?.backfill_preview_json?.invoices_count || 0)
    const regularCount = Number(profile?.backfill_preview_json?.periods_regular_count || 0)
    const entriesCount = Number(profile?.backfill_preview_json?.entries_count || 0)
    return invoicesCount > 0 && (regularCount <= 0 || entriesCount <= 0)
  }, [profile?.backfill_preview_json])
  const vatNotApplicable = useMemo(() => {
    const r = String(fiscalRegime || '').toUpperCase()
    return r === 'RF19' || r === 'RF02'
  }, [fiscalRegime])

  const currentSummary = useMemo(() => {
    if (!periods.length) return null
    const today = new Date().toISOString().slice(0, 10)
    let current = periods.find((p) => p.period_type === 'regular' && p.period_start <= today && p.period_end >= today)
    if (!current) {
      current = periods
        .filter((p) => p.status === 'to_pay' || p.status === 'overdue')
        .sort((a, b) => a.due_date.localeCompare(b.due_date))[0]
    }
    if (!current) {
      current = [...periods].sort((a, b) => b.period_end.localeCompare(a.period_end))[0]
    }
    return current || null
  }, [periods])

  const loadBreakdown = useCallback(async (periodId: string) => {
    if (!company?.id) return
    try {
      const data = await listVatBreakdown(company.id, periodId)
      setBreakdown(data)
      setCurrentPeriodId(periodId)
      setSnapshotEntries([])
      setSnapshotPeriodId(null)
    } catch (e: any) {
      setError(e.message || 'Errore caricamento dettaglio IVA')
    }
  }, [company?.id])

  const loadSnapshotAudit = useCallback(async (periodId: string) => {
    if (!company?.id) return
    setSnapshotLoading(true)
    setError(null)
    try {
      const data = await listVatPeriodSnapshotEntries(company.id, periodId)
      setSnapshotEntries(data)
      setSnapshotPeriodId(periodId)
    } catch (e: any) {
      setError(e.message || 'Errore caricamento snapshot audit')
    } finally {
      setSnapshotLoading(false)
    }
  }, [company?.id])

  const refreshPeriods = useCallback(async () => {
    if (!company?.id) return

    const [list, manual] = await Promise.all([
      listVatPeriodsLight(company.id),
      listManualVatEntries(company.id),
    ])
    setPeriods(list)
    setManualEntries(manual)

    if (list.length > 0) {
      const selected = currentPeriodId && list.some((p) => p.id === currentPeriodId)
        ? currentPeriodId
        : list.find((p) => p.period_type === 'regular')?.id || list[0].id
      if (selected) await loadBreakdown(selected)
    } else {
      setBreakdown([])
      setCurrentPeriodId(null)
      setSnapshotEntries([])
      setSnapshotPeriodId(null)
    }
  }, [company?.id, currentPeriodId, loadBreakdown])

  const loadAll = useCallback(async () => {
    if (!company?.id) return

    setLoading(true)
    setError(null)

    try {
      const [memberRole, fiscal, currentProfile] = await Promise.all([
        getCompanyRole(company.id),
        getCompanyFiscalRegime(company.id),
        getVatProfile(company.id),
      ])

      setRole(memberRole)
      setFiscalRegime(fiscal)
      setProfile(currentProfile)

      if (!currentProfile) {
        const firstInvoiceDate = await getFirstInvoiceDate(company.id)
        const startDate = firstInvoiceDate || new Date().toISOString().slice(0, 10)
        setProfileForm(emptyProfileInput(startDate))
        setPeriods([])
        setManualEntries([])
        setBreakdown([])
        setSnapshotEntries([])
        setSnapshotPeriodId(null)
        setCurrentPeriodId(null)
        setMatchesByPeriod({})
        return
      }

      setProfileForm(fromProfile(currentProfile))

      let currentPeriods = await listVatPeriodsLight(company.id)
      if (currentPeriods.length === 0) {
        await syncVatEngine(company.id, { requireBackfillConfirmation: isEditor(memberRole) })
        currentPeriods = await listVatPeriodsLight(company.id)
        const refreshed = await getVatProfile(company.id)
        setProfile(refreshed)
        if (refreshed) setProfileForm(fromProfile(refreshed))
      }

      setPeriods(currentPeriods)
      const manual = await listManualVatEntries(company.id)
      setManualEntries(manual)
      const selected = currentPeriods.find((p) => p.period_type === 'regular')?.id || currentPeriods[0]?.id || null
      if (selected) {
        setCurrentPeriodId(selected)
        const bd = await listVatBreakdown(company.id, selected)
        setBreakdown(bd)
      }

      await getVatCurrentSummary(company.id)
    } catch (e: any) {
      const message = e?.message || 'Errore caricamento modulo IVA'
      setError(
        isTimeoutVatError(message)
          ? 'Ricalcolo IVA non completato per timeout query: i dati precedenti sono stati mantenuti.'
          : message,
      )
    } finally {
      setLoading(false)
    }
  }, [company?.id])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  const handleSaveProfile = async () => {
    if (!company?.id || !profileForm) return

    setSavingProfile(true)
    setError(null)
    setInfo(null)

    try {
      const saved = await upsertVatProfile(company.id, profileForm)
      setProfile(saved)
      setProfileForm(fromProfile(saved))
      await syncVatEngine(company.id, { requireBackfillConfirmation: true })
      const refreshedProfile = await getVatProfile(company.id)
      if (refreshedProfile) {
        setProfile(refreshedProfile)
        setProfileForm(fromProfile(refreshedProfile))
      }
      await refreshPeriods()
      setInfo('Configurazione IVA salvata. Verifica il riepilogo backfill e conferma prima di operare.')
    } catch (e: any) {
      const message = e?.message || 'Errore salvataggio profilo IVA'
      setError(
        isTimeoutVatError(message)
          ? 'Ricalcolo IVA non completato per timeout query: i dati precedenti sono stati mantenuti.'
          : message,
      )
    } finally {
      setSavingProfile(false)
    }
  }

  const handleRecompute = async () => {
    if (!company?.id || !profile) return
    setSyncing(true)
    setError(null)
    setInfo(null)
    try {
      const result = await syncVatEngine(company.id)
      const refreshedProfile = await getVatProfile(company.id)
      if (refreshedProfile) setProfile(refreshedProfile)
      await refreshPeriods()
      setInfo(`Ricalcolo IVA completato (${result.invoices_processed} fatture, ${result.entries_written} movimenti, ${result.periods_upserted} periodi)`)
    } catch (e: any) {
      const message = e?.message || 'Errore ricalcolo IVA'
      setError(
        isTimeoutVatError(message)
          ? 'Ricalcolo IVA non completato per timeout query: i dati precedenti sono stati mantenuti.'
          : message,
      )
    } finally {
      setSyncing(false)
    }
  }

  const handleSuggestMatches = async (periodId: string) => {
    if (!company?.id) return
    if (!hasRegularPeriods) return
    setError(null)
    try {
      await suggestVatMatches(company.id, periodId)
      const matches = await listVatPaymentMatches(company.id, periodId)
      setMatchesByPeriod((prev) => ({ ...prev, [periodId]: matches }))
      setInfo(matches.length > 0 ? `${matches.length} suggerimento/i F24 trovati` : 'Nessun suggerimento F24 compatibile')
    } catch (e: any) {
      setError(e.message || 'Errore ricerca suggerimenti F24')
    }
  }

  const handleConfirmManualPaid = async (period: VatPeriod) => {
    if (!company?.id) return
    if (!hasRegularPeriods) return
    if (!window.confirm(`Confermi il versamento del periodo ${formatVatPeriodLabel(period)}?`)) return

    try {
      await confirmVatPayment(company.id, {
        vatPeriodId: period.id,
        paidAmount: period.amount_due,
        paymentMethod: 'manual',
        paymentNote: 'Conferma manuale utente',
      })
      await refreshPeriods()
      setInfo(`Periodo ${formatVatPeriodLabel(period)} marcato come versato`)
    } catch (e: any) {
      setError(e.message || 'Errore conferma versamento')
    }
  }

  const handleAcceptMatch = async (periodId: string, match: VatPaymentMatch) => {
    if (!company?.id) return
    if (!hasRegularPeriods) return

    try {
      await confirmVatPayment(company.id, {
        vatPeriodId: periodId,
        bankTransactionId: match.bank_transaction_id,
        paidAmount: Math.abs(Number(match.bank_transaction?.amount || match.suggested_amount || 0)),
        paymentMethod: 'f24',
        paymentNote: 'Confermato da suggerimento F24',
      })
      await refreshPeriods()
      const updatedMatches = await listVatPaymentMatches(company.id, periodId)
      setMatchesByPeriod((prev) => ({ ...prev, [periodId]: updatedMatches }))
      setInfo('Versamento confermato da movimento F24')
    } catch (e: any) {
      setError(e.message || 'Errore conferma match F24')
    }
  }

  const handleConfirmBackfill = async () => {
    if (!company?.id) return
    try {
      await confirmVatBackfill(company.id)
      const refreshed = await getVatProfile(company.id)
      if (refreshed) setProfile(refreshed)
      setInfo('Backfill confermato. Le liquidazioni IVA sono ora operative.')
    } catch (e: any) {
      setError(e.message || 'Errore conferma backfill')
    }
  }

  const handleAddManualEntry = async () => {
    if (!company?.id) return
    try {
      await createManualVatEntry(company.id, manualForm)
      await syncVatEngine(company.id)
      await refreshPeriods()
      setManualForm((prev) => ({ ...prev, manual_note: '', vat_amount: 0, vat_debit_amount: 0, vat_credit_amount: 0, taxable_amount: 0 }))
      setInfo('Rettifica manuale IVA aggiunta')
    } catch (e: any) {
      setError(e.message || 'Errore inserimento rettifica manuale')
    }
  }

  const handleDeleteManualEntry = async (entryId: string) => {
    if (!company?.id) return
    if (!window.confirm('Eliminare questa rettifica manuale IVA?')) return
    try {
      await deleteManualVatEntry(company.id, entryId)
      await syncVatEngine(company.id)
      await refreshPeriods()
      setInfo('Rettifica manuale eliminata')
    } catch (e: any) {
      setError(e.message || 'Errore eliminazione rettifica manuale')
    }
  }

  if (!company) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">Azienda non disponibile. Importa almeno una fattura per iniziare.</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">Caricamento modulo IVA...</p>
      </div>
    )
  }

  if (vatNotApplicable) {
    return (
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">IVA</h1>
          <p className="text-muted-foreground text-sm mt-1">Liquidazioni periodiche e scadenze fiscali</p>
        </div>

        <Card>
          <CardContent className="p-6 space-y-2">
            <p className="text-sm font-semibold text-amber-700">Liquidazione IVA non applicabile</p>
            <p className="text-sm text-muted-foreground">
              Il regime fiscale aziendale corrente ({fiscalRegime || 'non impostato'}) non richiede liquidazione IVA periodica.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">IVA</h1>
          <p className="text-muted-foreground text-sm mt-1">Liquidazioni periodiche, storico versamenti e suggerimenti F24</p>
        </div>
        {profile && (
          <Button onClick={handleRecompute} disabled={syncing} className="w-full sm:w-auto">
            <RefreshCw className={`h-4 w-4 mr-2 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Ricalcolo...' : 'Ricalcola IVA'}
          </Button>
        )}
      </div>

      {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
      {info && <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">{info}</div>}

      {profile && backfillPending && (
        <Card className="border-amber-200 bg-amber-50/40">
          <CardHeader>
            <CardTitle className="text-base text-amber-800">Validazione backfill richiesta</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-amber-800">
              Prima di rendere operativi i dati IVA, verifica il riepilogo del backfill calcolato.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-5 gap-2 text-sm">
              <div className="rounded border bg-white px-3 py-2">
                <p className="text-xs text-gray-500 uppercase">Fatture trovate</p>
                <p className="font-semibold">{Number(profile.backfill_preview_json?.invoices_count || 0)}</p>
              </div>
              <div className="rounded border bg-white px-3 py-2">
                <p className="text-xs text-gray-500 uppercase">Entry IVA</p>
                <p className="font-semibold">{Number(profile.backfill_preview_json?.entries_count || 0)}</p>
              </div>
              <div className="rounded border bg-white px-3 py-2">
                <p className="text-xs text-gray-500 uppercase">Periodi calcolati</p>
                <p className="font-semibold">{Number(profile.backfill_preview_json?.periods_regular_count || 0)}</p>
              </div>
              <div className="rounded border bg-white px-3 py-2">
                <p className="text-xs text-gray-500 uppercase">Totale debito</p>
                <p className="font-semibold">{fmtEur((profile.backfill_preview_json?.totals as any)?.vat_debit || 0)}</p>
              </div>
              <div className="rounded border bg-white px-3 py-2">
                <p className="text-xs text-gray-500 uppercase">Totale credito</p>
                <p className="font-semibold">{fmtEur((profile.backfill_preview_json?.totals as any)?.vat_credit || 0)}</p>
              </div>
            </div>
            {backfillPreviewInconsistent && (
              <p className="text-xs text-red-700">
                Backfill non confermabile: fatture presenti ma periodi/entry IVA mancanti. Riesegui il ricalcolo.
              </p>
            )}
            {canEdit ? (
              <div className="flex justify-end">
                <Button disabled={backfillPreviewInconsistent} onClick={handleConfirmBackfill}>Conferma backfill</Button>
              </div>
            ) : (
              <p className="text-xs text-amber-700">Solo owner/admin possono confermare il backfill.</p>
            )}
          </CardContent>
        </Card>
      )}

      {!profile && profileForm && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              Wizard configurazione fiscale IVA
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!canEdit && (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                Solo owner/admin possono completare la configurazione IVA.
              </p>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Regime liquidazione</Label>
                <select
                  disabled={!canEdit}
                  value={profileForm.liquidation_regime}
                  onChange={(e) => setProfileForm((f) => f ? ({ ...f, liquidation_regime: e.target.value as 'monthly' | 'quarterly' }) : f)}
                  className="mt-1 w-full border rounded-md px-2 py-2 text-sm"
                >
                  <option value="monthly">Mensile</option>
                  <option value="quarterly">Trimestrale</option>
                </select>
              </div>

              <div>
                <Label className="text-xs">Tipo attivita</Label>
                <select
                  disabled={!canEdit}
                  value={profileForm.activity_type}
                  onChange={(e) => setProfileForm((f) => f ? ({ ...f, activity_type: e.target.value as 'services' | 'other' }) : f)}
                  className="mt-1 w-full border rounded-md px-2 py-2 text-sm"
                >
                  <option value="services">Prevalenza servizi</option>
                  <option value="other">Commercio/produzione</option>
                </select>
              </div>

              <div>
                <Label className="text-xs">Data inizio calcolo</Label>
                <Input
                  disabled={!canEdit}
                  type="date"
                  value={profileForm.start_date}
                  onChange={(e) => setProfileForm((f) => f ? ({ ...f, start_date: e.target.value }) : f)}
                  className="mt-1"
                />
              </div>

              <div>
                <Label className="text-xs">Override acconto (EUR, opzionale)</Label>
                <Input
                  disabled={!canEdit}
                  type="number"
                  step="0.01"
                  value={profileForm.acconto_override_amount ?? ''}
                  onChange={(e) => setProfileForm((f) => f ? ({
                    ...f,
                    acconto_override_amount: e.target.value === '' ? null : Number(e.target.value),
                  }) : f)}
                  className="mt-1"
                />
              </div>

              <div>
                <Label className="text-xs">Saldo iniziale credito IVA (EUR)</Label>
                <Input
                  disabled={!canEdit}
                  type="number"
                  step="0.01"
                  value={profileForm.opening_vat_credit}
                  onChange={(e) => setProfileForm((f) => f ? ({ ...f, opening_vat_credit: Number(e.target.value || 0) }) : f)}
                  className="mt-1"
                />
              </div>

              <div>
                <Label className="text-xs">Saldo iniziale debito &lt; 100 EUR (EUR)</Label>
                <Input
                  disabled={!canEdit}
                  type="number"
                  step="0.01"
                  value={profileForm.opening_vat_debit}
                  onChange={(e) => setProfileForm((f) => f ? ({ ...f, opening_vat_debit: Number(e.target.value || 0) }) : f)}
                  className="mt-1"
                />
              </div>
            </div>

            <label className="inline-flex items-center gap-2 text-sm">
              <input
                disabled={!canEdit}
                type="checkbox"
                checked={profileForm.commercialista_confirmed}
                onChange={(e) => setProfileForm((f) => f ? ({ ...f, commercialista_confirmed: e.target.checked }) : f)}
              />
              Dati verificati con commercialista
            </label>

            {canEdit && (
              <div className="flex justify-end">
                <Button onClick={handleSaveProfile} disabled={savingProfile}>
                  {savingProfile ? 'Salvataggio...' : 'Conferma configurazione IVA'}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {profile && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Calculator className="h-4 w-4" />
                Riepilogo periodo corrente
              </CardTitle>
            </CardHeader>
            <CardContent>
              {currentSummary ? (
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <div className="rounded-lg border bg-emerald-50 border-emerald-200 p-3">
                    <p className="text-xs text-emerald-700 uppercase">IVA a debito</p>
                    <p className="text-lg font-bold text-emerald-800">{fmtEur(currentSummary.vat_debit)}</p>
                  </div>
                  <div className="rounded-lg border bg-blue-50 border-blue-200 p-3">
                    <p className="text-xs text-blue-700 uppercase">IVA a credito</p>
                    <p className="text-lg font-bold text-blue-800">{fmtEur(currentSummary.vat_credit)}</p>
                  </div>
                  <div className="rounded-lg border bg-amber-50 border-amber-200 p-3">
                    <p className="text-xs text-amber-700 uppercase">Saldo da versare</p>
                    <p className="text-lg font-bold text-amber-800">{fmtEur(currentSummary.amount_due)}</p>
                  </div>
                  <div className="rounded-lg border bg-gray-50 border-gray-200 p-3">
                    <p className="text-xs text-gray-700 uppercase">Scadenza</p>
                    <p className="text-sm font-semibold text-gray-900">{formatVatPeriodLabel(currentSummary)}</p>
                    <p className="text-sm text-gray-600 mt-1">{fmtDate(currentSummary.due_date)}</p>
                    <p className="text-xs mt-1 text-gray-500">{getDaysToDue(currentSummary.due_date)} giorni</p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Nessun periodo disponibile. Completa la configurazione e ricalcola.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <CalendarClock className="h-4 w-4" />
                Storico liquidazioni IVA
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {periods.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nessuna liquidazione calcolata.</p>
              ) : (
                <div className="overflow-x-auto border rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-3 py-2">Periodo</th>
                        <th className="text-right px-3 py-2">Debito</th>
                        <th className="text-right px-3 py-2">Credito</th>
                        <th className="text-right px-3 py-2">Saldo</th>
                        <th className="text-left px-3 py-2">Scadenza</th>
                        <th className="text-left px-3 py-2">Stato</th>
                        <th className="text-right px-3 py-2">Azioni</th>
                      </tr>
                    </thead>
                    <tbody>
                      {periods.map((p) => (
                        <tr key={p.id} className="border-t">
                          <td className="px-3 py-2 font-medium">{formatVatPeriodLabel(p)}</td>
                          <td className="px-3 py-2 text-right">{fmtEur(p.vat_debit)}</td>
                          <td className="px-3 py-2 text-right">{fmtEur(p.vat_credit)}</td>
                          <td className="px-3 py-2 text-right font-semibold">{fmtEur(p.amount_due > 0 ? p.amount_due : p.amount_credit_carry)}</td>
                          <td className="px-3 py-2">{fmtDate(p.due_date)}</td>
                          <td className="px-3 py-2">
                            <span className={`text-[11px] px-2 py-1 rounded-full font-medium ${statusClass(p.status)}`}>
                              {statusLabel(p.status)}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex justify-end gap-2 flex-wrap">
                              <Button variant="outline" size="sm" onClick={() => loadBreakdown(p.id)}>Dettaglio</Button>
                              {(p.status === 'to_pay' || p.status === 'overdue') && (
                                <Button variant="outline" size="sm" disabled={backfillPending || !hasRegularPeriods} onClick={() => handleSuggestMatches(p.id)}>
                                  Suggerisci F24
                                </Button>
                              )}
                              {(p.status === 'to_pay' || p.status === 'overdue') && canEdit && (
                                <Button size="sm" disabled={backfillPending || !hasRegularPeriods} onClick={() => handleConfirmManualPaid(p)}>Segna versato</Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {Object.entries(matchesByPeriod).map(([periodId, matches]) => {
                if (!matches.length) return null
                const period = periods.find((p) => p.id === periodId)
                if (!period) return null

                return (
                  <div key={periodId} className="border rounded-lg p-3">
                    <p className="text-sm font-semibold mb-2">Suggerimenti F24 - {formatVatPeriodLabel(period)}</p>
                    <div className="space-y-2">
                      {matches.map((m) => (
                        <div key={m.id} className="border rounded-md px-3 py-2 flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                          <div className="text-xs text-gray-600">
                            <p className="font-medium text-gray-900">{fmtDate(m.bank_transaction?.date || '')} - {fmtEur(Math.abs(Number(m.bank_transaction?.amount || m.suggested_amount || 0)))}</p>
                            <p>{m.reason || 'Suggerimento automatico'}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={`text-[11px] px-2 py-1 rounded-full font-medium ${statusClass(m.status)}`}>
                              {m.status}
                            </span>
                            {m.status !== 'accepted' && canEdit && (
                              <Button size="sm" disabled={backfillPending} onClick={() => handleAcceptMatch(periodId, m)}>
                                Conferma
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Receipt className="h-4 w-4" />
                Dettaglio per aliquota/natura/esigibilita
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {currentPeriodId && (
                <div className="flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => loadSnapshotAudit(currentPeriodId)}
                    disabled={snapshotLoading}
                  >
                    {snapshotLoading ? 'Caricamento snapshot...' : 'Mostra snapshot audit'}
                  </Button>
                </div>
              )}
              {!currentPeriodId ? (
                <p className="text-sm text-muted-foreground">Seleziona un periodo dallo storico per vedere il dettaglio.</p>
              ) : breakdown.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nessun dettaglio IVA disponibile per il periodo selezionato.</p>
              ) : (
                <div className="overflow-x-auto border rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-3 py-2">Aliquota</th>
                        <th className="text-left px-3 py-2">Natura</th>
                        <th className="text-left px-3 py-2">Esig.</th>
                        <th className="text-left px-3 py-2">Tipo</th>
                        <th className="text-right px-3 py-2">Imponibile</th>
                        <th className="text-right px-3 py-2">IVA</th>
                        <th className="text-right px-3 py-2">Debito</th>
                        <th className="text-right px-3 py-2">Credito</th>
                      </tr>
                    </thead>
                    <tbody>
                      {breakdown.map((r, i) => (
                        <tr key={`${r.vat_rate}-${r.vat_nature}-${r.esigibilita}-${i}`} className="border-t">
                          <td className="px-3 py-2">{r.vat_rate}%</td>
                          <td className="px-3 py-2">{r.vat_nature || '—'}</td>
                          <td className="px-3 py-2">{r.esigibilita}</td>
                          <td className="px-3 py-2">
                            {r.is_reverse_charge ? 'Reverse charge' : r.is_split_payment ? 'Split payment' : r.direction === 'out' ? 'Vendita' : 'Acquisto'}
                          </td>
                          <td className="px-3 py-2 text-right">{fmtEur(r.taxable_amount)}</td>
                          <td className="px-3 py-2 text-right">{fmtEur(r.vat_amount)}</td>
                          <td className="px-3 py-2 text-right">{fmtEur(r.vat_debit_amount)}</td>
                          <td className="px-3 py-2 text-right">{fmtEur(r.vat_credit_amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {snapshotPeriodId === currentPeriodId && (
                <div className="border rounded-lg p-3 space-y-2">
                  <p className="text-sm font-semibold">Snapshot audit periodo ({snapshotEntries.length} entry)</p>
                  {snapshotEntries.length === 0 ? (
                    <p className="text-xs text-muted-foreground">Nessuna entry audit disponibile per questo periodo.</p>
                  ) : (
                    <div className="overflow-x-auto border rounded-lg">
                      <table className="w-full text-xs">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="text-left px-2 py-1">Data</th>
                            <th className="text-left px-2 py-1">Documento</th>
                            <th className="text-right px-2 py-1">Debito</th>
                            <th className="text-right px-2 py-1">Credito</th>
                            <th className="text-left px-2 py-1">Nota</th>
                          </tr>
                        </thead>
                        <tbody>
                          {snapshotEntries.map((entry) => {
                            const payload = entry.entry_payload || {}
                            return (
                              <tr key={entry.id} className="border-t">
                                <td className="px-2 py-1">{fmtDate(String(payload.effective_date || ''))}</td>
                                <td className="px-2 py-1">{String(payload.doc_type || '—')}</td>
                                <td className="px-2 py-1 text-right">{fmtEur(Number(payload.vat_debit_amount || 0))}</td>
                                <td className="px-2 py-1 text-right">{fmtEur(Number(payload.vat_credit_amount || 0))}</td>
                                <td className="px-2 py-1">{String(payload.manual_note || payload.notes || '—')}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Rettifiche manuali IVA</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-xs text-muted-foreground">
                Usa questa sezione per aggiustamenti non derivanti da fatture (es. IVA indetraibile/autoconsumo).
              </p>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs">Data competenza</Label>
                  <Input
                    type="date"
                    disabled={!canEdit || backfillPending}
                    value={manualForm.effective_date}
                    onChange={(e) => setManualForm((m) => ({ ...m, effective_date: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">Imponibile</Label>
                  <Input
                    type="number"
                    step="0.01"
                    disabled={!canEdit || backfillPending}
                    value={manualForm.taxable_amount}
                    onChange={(e) => setManualForm((m) => ({ ...m, taxable_amount: Number(e.target.value || 0) }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">IVA</Label>
                  <Input
                    type="number"
                    step="0.01"
                    disabled={!canEdit || backfillPending}
                    value={manualForm.vat_amount}
                    onChange={(e) => setManualForm((m) => ({ ...m, vat_amount: Number(e.target.value || 0) }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">IVA a debito</Label>
                  <Input
                    type="number"
                    step="0.01"
                    disabled={!canEdit || backfillPending}
                    value={manualForm.vat_debit_amount}
                    onChange={(e) => setManualForm((m) => ({ ...m, vat_debit_amount: Number(e.target.value || 0) }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">IVA a credito</Label>
                  <Input
                    type="number"
                    step="0.01"
                    disabled={!canEdit || backfillPending}
                    value={manualForm.vat_credit_amount}
                    onChange={(e) => setManualForm((m) => ({ ...m, vat_credit_amount: Number(e.target.value || 0) }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">Aliquota</Label>
                  <Input
                    type="number"
                    step="0.01"
                    disabled={!canEdit || backfillPending}
                    value={manualForm.vat_rate || 0}
                    onChange={(e) => setManualForm((m) => ({ ...m, vat_rate: Number(e.target.value || 0) }))}
                    className="mt-1"
                  />
                </div>
              </div>

              <div>
                <Label className="text-xs">Nota rettifica</Label>
                <Input
                  disabled={!canEdit || backfillPending}
                  value={manualForm.manual_note}
                  onChange={(e) => setManualForm((m) => ({ ...m, manual_note: e.target.value }))}
                  className="mt-1"
                  placeholder="Es. IVA indetraibile per autoconsumo"
                />
              </div>

              {canEdit && (
                <div className="flex justify-end">
                  <Button disabled={backfillPending} onClick={handleAddManualEntry}>Aggiungi rettifica</Button>
                </div>
              )}

              {manualEntries.length > 0 && (
                <div className="overflow-x-auto border rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-3 py-2">Data</th>
                        <th className="text-right px-3 py-2">Debito</th>
                        <th className="text-right px-3 py-2">Credito</th>
                        <th className="text-left px-3 py-2">Nota</th>
                        <th className="text-right px-3 py-2">Azioni</th>
                      </tr>
                    </thead>
                    <tbody>
                      {manualEntries.map((m) => (
                        <tr key={m.id} className="border-t">
                          <td className="px-3 py-2">{fmtDate(m.effective_date)}</td>
                          <td className="px-3 py-2 text-right">{fmtEur(m.vat_debit_amount)}</td>
                          <td className="px-3 py-2 text-right">{fmtEur(m.vat_credit_amount)}</td>
                          <td className="px-3 py-2 text-xs">{m.manual_note || m.notes || '—'}</td>
                          <td className="px-3 py-2">
                            <div className="flex justify-end">
                              {canEdit && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={backfillPending}
                                  onClick={() => handleDeleteManualEntry(m.id)}
                                >
                                  Elimina
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {profileForm && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Configurazione fiscale</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-xs text-muted-foreground">
                  Regime attivo: <strong>{profileForm.liquidation_regime === 'monthly' ? 'Mensile' : 'Trimestrale'}</strong> -
                  Attivita: <strong>{profileForm.activity_type === 'services' ? 'Servizi' : 'Commercio/Produzione'}</strong>
                </p>

                {!canEdit && (
                  <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                    Solo owner/admin possono modificare la configurazione fiscale.
                  </p>
                )}

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs">Regime liquidazione</Label>
                    <select
                      disabled={!canEdit}
                      value={profileForm.liquidation_regime}
                      onChange={(e) => setProfileForm((f) => f ? ({ ...f, liquidation_regime: e.target.value as 'monthly' | 'quarterly' }) : f)}
                      className="mt-1 w-full border rounded-md px-2 py-2 text-sm"
                    >
                      <option value="monthly">Mensile</option>
                      <option value="quarterly">Trimestrale</option>
                    </select>
                  </div>

                  <div>
                    <Label className="text-xs">Tipo attivita</Label>
                    <select
                      disabled={!canEdit}
                      value={profileForm.activity_type}
                      onChange={(e) => setProfileForm((f) => f ? ({ ...f, activity_type: e.target.value as 'services' | 'other' }) : f)}
                      className="mt-1 w-full border rounded-md px-2 py-2 text-sm"
                    >
                      <option value="services">Servizi</option>
                      <option value="other">Commercio/produzione</option>
                    </select>
                  </div>

                  <div>
                    <Label className="text-xs">Data inizio</Label>
                    <Input
                      disabled={!canEdit}
                      type="date"
                      value={profileForm.start_date}
                      onChange={(e) => setProfileForm((f) => f ? ({ ...f, start_date: e.target.value }) : f)}
                      className="mt-1"
                    />
                  </div>

                  <div>
                    <Label className="text-xs">Credito iniziale</Label>
                    <Input
                      disabled={!canEdit}
                      type="number"
                      step="0.01"
                      value={profileForm.opening_vat_credit}
                      onChange={(e) => setProfileForm((f) => f ? ({ ...f, opening_vat_credit: Number(e.target.value || 0) }) : f)}
                      className="mt-1"
                    />
                  </div>

                  <div>
                    <Label className="text-xs">Debito iniziale &lt; 100</Label>
                    <Input
                      disabled={!canEdit}
                      type="number"
                      step="0.01"
                      value={profileForm.opening_vat_debit}
                      onChange={(e) => setProfileForm((f) => f ? ({ ...f, opening_vat_debit: Number(e.target.value || 0) }) : f)}
                      className="mt-1"
                    />
                  </div>

                  <div>
                    <Label className="text-xs">Override acconto</Label>
                    <Input
                      disabled={!canEdit}
                      type="number"
                      step="0.01"
                      value={profileForm.acconto_override_amount ?? ''}
                      onChange={(e) => setProfileForm((f) => f ? ({ ...f, acconto_override_amount: e.target.value === '' ? null : Number(e.target.value) }) : f)}
                      className="mt-1"
                    />
                  </div>
                </div>

                <label className="inline-flex items-center gap-2 text-sm">
                  <input
                    disabled={!canEdit}
                    type="checkbox"
                    checked={profileForm.commercialista_confirmed}
                    onChange={(e) => setProfileForm((f) => f ? ({ ...f, commercialista_confirmed: e.target.checked }) : f)}
                  />
                  Conferma commercialista
                </label>

                {canEdit && (
                  <div className="flex justify-end">
                    <Button onClick={handleSaveProfile} disabled={savingProfile}>
                      {savingProfile ? 'Salvataggio...' : 'Salva configurazione'}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
