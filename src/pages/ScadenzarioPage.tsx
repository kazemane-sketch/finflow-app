import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CalendarClock, Receipt, FileText } from 'lucide-react'
import { useCompany } from '@/hooks/useCompany'
import { supabase } from '@/integrations/supabase/client'
import { fmtDate, fmtEur } from '@/lib/utils'
import { listVatPeriods, formatVatPeriodLabel, type VatPeriod } from '@/lib/vat'

type DueItem = {
  id: string
  kind: 'invoice' | 'vat'
  title: string
  due_date: string
  amount: number
  status: string
}

function statusClass(status: string): string {
  if (status === 'overdue') return 'bg-red-100 text-red-700'
  if (status === 'paid') return 'bg-emerald-100 text-emerald-700'
  if (status === 'to_pay' || status === 'pending') return 'bg-amber-100 text-amber-700'
  return 'bg-gray-100 text-gray-700'
}

export default function ScadenzarioPage() {
  const { company } = useCompany()
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<DueItem[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    async function load() {
      if (!company?.id) {
        if (mounted) {
          setItems([])
          setLoading(false)
        }
        return
      }

      setLoading(true)
      setError(null)

      try {
        const today = new Date().toISOString().slice(0, 10)

        const [invoiceResp, vatPeriods] = await Promise.all([
          supabase
            .from('invoices')
            .select('id, number, payment_due_date, total_amount, payment_status')
            .eq('company_id', company.id)
            .not('payment_due_date', 'is', null)
            .in('payment_status', ['pending', 'overdue'])
            .order('payment_due_date', { ascending: true })
            .limit(200),
          listVatPeriods(company.id),
        ])

        if (invoiceResp.error) throw new Error(invoiceResp.error.message)

        const invoiceItems: DueItem[] = (invoiceResp.data || []).map((inv: any) => ({
          id: String(inv.id),
          kind: 'invoice',
          title: `Fattura ${inv.number || 'senza numero'}`,
          due_date: String(inv.payment_due_date),
          amount: Number(inv.total_amount || 0),
          status: String(inv.payment_status || 'pending'),
        }))

        const vatItems: DueItem[] = (vatPeriods || [])
          .filter((p: VatPeriod) => ['to_pay', 'overdue', 'paid'].includes(p.status))
          .map((p) => ({
            id: p.id,
            kind: 'vat',
            title: `IVA ${formatVatPeriodLabel(p)}`,
            due_date: p.due_date,
            amount: Number(p.amount_due || p.paid_amount || 0),
            status: p.status,
          }))

        const merged = [...invoiceItems, ...vatItems]
          .sort((a, b) => a.due_date.localeCompare(b.due_date))

        if (mounted) setItems(merged)
      } catch (e: any) {
        if (mounted) setError(e.message || 'Errore caricamento scadenzario')
      } finally {
        if (mounted) setLoading(false)
      }
    }

    load()
    return () => {
      mounted = false
    }
  }, [company?.id])

  const stats = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10)
    const overdue = items.filter((i) => i.due_date < today && i.status !== 'paid').length
    const upcoming = items.filter((i) => i.due_date >= today && i.status !== 'paid').length
    const vatCount = items.filter((i) => i.kind === 'vat' && i.status !== 'paid').length
    return { overdue, upcoming, vatCount }
  }, [items])

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Scadenzario</h1>
        <p className="text-muted-foreground text-sm mt-1">Scadenze fatture e liquidazioni IVA</p>
      </div>

      {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground uppercase">In scadenza</p>
            <p className="text-2xl font-bold mt-1">{stats.upcoming}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground uppercase">Scadute</p>
            <p className="text-2xl font-bold mt-1 text-red-600">{stats.overdue}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground uppercase">Eventi IVA</p>
            <p className="text-2xl font-bold mt-1 text-amber-700">{stats.vatCount}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarClock className="h-4 w-4" />
            Timeline scadenze
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Caricamento scadenze...</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nessuna scadenza disponibile.</p>
          ) : (
            <div className="space-y-2">
              {items.map((item) => (
                <div key={`${item.kind}-${item.id}`} className="border rounded-lg px-3 py-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <div className="flex items-start gap-2">
                    <div className="mt-0.5">
                      {item.kind === 'vat'
                        ? <Receipt className="h-4 w-4 text-amber-600" />
                        : <FileText className="h-4 w-4 text-blue-600" />}
                    </div>
                    <div>
                      <p className="text-sm font-medium">{item.title}</p>
                      <p className="text-xs text-muted-foreground">Scadenza {fmtDate(item.due_date)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{fmtEur(item.amount)}</span>
                    <span className={`text-[11px] px-2 py-1 rounded-full font-medium ${statusClass(item.status)}`}>
                      {item.status === 'pending' ? 'Da pagare' : item.status === 'to_pay' ? 'Da versare' : item.status === 'overdue' ? 'Scaduto' : item.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
