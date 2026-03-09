// exportService.ts — Excel export for accountant (commercialista)
// Generates a multi-sheet XLSX file entirely client-side using SheetJS.

import * as XLSX from 'xlsx'
import { supabase } from '@/integrations/supabase/client'

/* ─── Types ─────────────────────────────── */

export interface ExportFilters {
  dateFrom: string
  dateTo: string
  direction?: 'in' | 'out' | 'all'
  onlyConfirmed?: boolean
  includeBank?: boolean
  includeReconciliations?: boolean
}

export interface ExportCounts {
  invoices: number
  bankMovements: number
  reconciliations: number
}

/* ─── Helpers ───────────────────────────── */

function fmtDateIT(d: string | null | undefined): string {
  if (!d) return ''
  const [y, m, dd] = d.split('-')
  return `${dd}/${m}/${y}`
}

function fmtNum(n: number | null | undefined): number | string {
  if (n == null) return ''
  return Math.round(n * 100) / 100
}

/** Paginated Supabase query — fetches all rows across multiple pages */
async function fetchAll<T>(
  query: any,
  pageSize = 1000,
): Promise<T[]> {
  const results: T[] = []
  let from = 0
  while (true) {
    const { data, error } = await query.range(from, from + pageSize - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    results.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }
  return results
}

/* ─── Sheet styling constants ────────── */

const HEADER_FILL = { fgColor: { rgb: '1e40af' } }
const HEADER_FONT = { color: { rgb: 'ffffff' }, bold: true, sz: 11 }
const ALT_FILL = { fgColor: { rgb: 'f8fafc' } }

function applyHeaderStyle(ws: XLSX.WorkSheet, colCount: number): void {
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1')
  for (let c = 0; c <= Math.min(colCount - 1, range.e.c); c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c })
    if (!ws[addr]) continue
    ws[addr].s = {
      fill: HEADER_FILL,
      font: HEADER_FONT,
      alignment: { horizontal: 'center', vertical: 'center' },
    }
  }
}

function autoFitColumns(ws: XLSX.WorkSheet, data: any[][], minWidth = 8, maxWidth = 40): void {
  if (!data.length) return
  const colWidths: number[] = []
  for (const row of data) {
    for (let c = 0; c < row.length; c++) {
      const len = String(row[c] ?? '').length
      colWidths[c] = Math.min(maxWidth, Math.max(colWidths[c] || minWidth, len + 2))
    }
  }
  ws['!cols'] = colWidths.map(w => ({ wch: w }))
}

/* ─── Counting function (for live preview) ── */

export async function getExportCounts(
  companyId: string,
  filters: ExportFilters,
): Promise<ExportCounts> {
  // Invoice lines count
  const invQuery = supabase
    .from('invoice_lines')
    .select('id', { count: 'exact', head: true })
    .eq('invoices.company_id', companyId)
  // This is complex — use a simpler count approach
  const { count: invCount } = await supabase
    .from('invoices')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .gte('date', filters.dateFrom)
    .lte('date', filters.dateTo)
    .then(r => {
      if (filters.direction && filters.direction !== 'all') {
        return supabase
          .from('invoices')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .eq('direction', filters.direction)
          .gte('date', filters.dateFrom)
          .lte('date', filters.dateTo)
      }
      return r
    })

  // Bank movements count
  let bankCount = 0
  if (filters.includeBank) {
    const { count } = await supabase
      .from('bank_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('tx_nature', 'no_invoice')
      .neq('classification_status', 'pending')
      .gte('date', filters.dateFrom)
      .lte('date', filters.dateTo)
    bankCount = count || 0
  }

  // Reconciliations count
  let reconCount = 0
  if (filters.includeReconciliations) {
    const { count } = await supabase
      .from('reconciliations')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .gte('confirmed_at', filters.dateFrom)
      .lte('confirmed_at', filters.dateTo + 'T23:59:59')
    reconCount = count || 0
  }

  return {
    invoices: invCount || 0,
    bankMovements: bankCount,
    reconciliations: reconCount,
  }
}

/* ─── Main export function ──────────────── */

export async function exportForCommercialista(
  companyId: string,
  companyName: string,
  filters: ExportFilters,
  onProgress?: (step: string) => void,
): Promise<void> {
  const wb = XLSX.utils.book_new()

  // ═══════════════════════════════════════
  // SHEET 1: Registrazioni Fatture
  // ═══════════════════════════════════════
  onProgress?.('Caricamento fatture...')

  let invoiceQuery = supabase
    .from('invoices')
    .select(`
      id, number, date, direction, total_amount, total_tax,
      counterparty:counterparties(name, vat_number),
      invoice_lines(
        description, quantity, unit_price, total_price, tax_rate,
        category:categories(name),
        account:chart_of_accounts(code, name),
        classification_status,
        fiscal_flags
      ),
      invoice_classifications(ai_confidence, ai_reasoning)
    `)
    .eq('company_id', companyId)
    .gte('date', filters.dateFrom)
    .lte('date', filters.dateTo)
    .order('date', { ascending: true })

  if (filters.direction && filters.direction !== 'all') {
    invoiceQuery = invoiceQuery.eq('direction', filters.direction)
  }

  const { data: invoices, error: invErr } = await invoiceQuery
  if (invErr) throw invErr

  const invoiceHeaders = [
    'Data Fattura', 'Tipo Doc', 'Numero', 'Direzione', 'Controparte', 'P.IVA',
    'Descrizione Riga', 'Qtà', 'Prezzo Unit.', 'Totale Riga',
    'Aliquota IVA %', 'Imponibile', 'IVA',
    'Categoria', 'Codice Conto', 'Nome Conto',
    'Stato', 'Deducibilità %', 'IVA Detraibilità %',
    'Ritenuta Acconto', 'Reverse Charge', 'Split Payment',
  ]

  const invoiceRows: any[][] = [invoiceHeaders]

  for (const inv of (invoices || [])) {
    const cp = inv.counterparty as any
    const dir = inv.direction === 'out' ? 'Attiva' : 'Passiva'
    const lines = (inv.invoice_lines || []) as any[]

    if (lines.length === 0) {
      // Invoice with no lines — single row
      invoiceRows.push([
        fmtDateIT(inv.date), 'Fattura', inv.number, dir,
        cp?.name || '', cp?.vat_number || '',
        '', '', '', fmtNum(inv.total_amount),
        '', fmtNum((inv.total_amount || 0) - (inv.total_tax || 0)), fmtNum(inv.total_tax),
        '', '', '',
        '', '', '', '', '', '',
      ])
    } else {
      for (const line of lines) {
        const ff = line.fiscal_flags || {}
        const cat = line.category as any
        const acc = line.account as any
        const status = filters.onlyConfirmed && line.classification_status !== 'confirmed'
          ? 'Non confermata'
          : line.classification_status === 'confirmed'
            ? 'Confermata'
            : line.classification_status === 'ai_suggested'
              ? 'Suggerita AI'
              : 'Non classificata'

        if (filters.onlyConfirmed && line.classification_status !== 'confirmed') continue

        invoiceRows.push([
          fmtDateIT(inv.date), 'Fattura', inv.number, dir,
          cp?.name || '', cp?.vat_number || '',
          line.description || '', fmtNum(line.quantity), fmtNum(line.unit_price), fmtNum(line.total_price),
          fmtNum(line.tax_rate), fmtNum(line.total_price), fmtNum((line.total_price || 0) * (line.tax_rate || 0) / 100),
          cat?.name || '', acc?.code || '', acc?.name || '',
          status,
          ff.deducibilita_pct != null ? fmtNum(ff.deducibilita_pct) : '',
          ff.iva_detraibilita_pct != null ? fmtNum(ff.iva_detraibilita_pct) : '',
          ff.ritenuta_acconto ? `Si (${ff.ritenuta_acconto.aliquota}%)` : '',
          ff.reverse_charge ? 'Si' : '',
          ff.split_payment ? 'Si' : '',
        ])
      }
    }
  }

  const ws1 = XLSX.utils.aoa_to_sheet(invoiceRows)
  applyHeaderStyle(ws1, invoiceHeaders.length)
  autoFitColumns(ws1, invoiceRows)
  ws1['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: invoiceRows.length - 1, c: invoiceHeaders.length - 1 } }) }
  ws1['!freeze'] = { xSplit: 0, ySplit: 1 }
  XLSX.utils.book_append_sheet(wb, ws1, 'Registrazioni Fatture')

  // ═══════════════════════════════════════
  // SHEET 2: Movimenti Bancari (senza fattura)
  // ═══════════════════════════════════════
  if (filters.includeBank) {
    onProgress?.('Caricamento movimenti bancari...')

    // Fonte A: movimenti no_invoice classificati
    const { data: noInvoiceTxs, error: bankErr } = await supabase
      .from('bank_transactions')
      .select(`
        id, date, amount, direction, counterparty_name, description,
        transaction_type, commission_amount,
        category:categories(name),
        account:chart_of_accounts(code, name),
        classification_status, classification_source, classification_reasoning,
        fiscal_flags, tx_nature,
        bank_account:bank_accounts(bank_name, iban)
      `)
      .eq('company_id', companyId)
      .eq('tx_nature', 'no_invoice')
      .neq('classification_status', 'pending')
      .gte('date', filters.dateFrom)
      .lte('date', filters.dateTo)
      .order('date', { ascending: true })

    if (bankErr) throw bankErr

    // Fonte B: commissioni da riconciliazioni
    const { data: commissions, error: commErr } = await supabase
      .from('reconciliations')
      .select(`
        reconciled_amount, match_reason, confirmed_at,
        bank_transaction:bank_transactions(
          id, date, commission_amount, counterparty_name, transaction_type,
          bank_account:bank_accounts(bank_name, iban)
        )
      `)
      .eq('company_id', companyId)
      .gte('confirmed_at', filters.dateFrom)
      .lte('confirmed_at', filters.dateTo + 'T23:59:59')
      .gt('bank_transactions.commission_amount', 0)

    if (commErr) console.warn('[export] commission query error:', commErr)

    const bankHeaders = [
      'Data', 'Importo', 'Direzione', 'Controparte', 'Descrizione',
      'Tipo Operazione', 'Banca', 'IBAN',
      'Codice Conto', 'Nome Conto', 'Categoria',
      'Stato', 'Note AI', 'Pagamento Tributo', 'Tipo Tributo', 'Fonte',
    ]
    const bankRows: any[][] = [bankHeaders]

    for (const tx of (noInvoiceTxs || [])) {
      const ba = tx.bank_account as any
      const cat = tx.category as any
      const acc = tx.account as any
      const ff = tx.fiscal_flags as any || {}
      bankRows.push([
        fmtDateIT(tx.date), fmtNum(tx.amount),
        tx.direction === 'in' ? 'Entrata' : 'Uscita',
        tx.counterparty_name || '', tx.description || '',
        tx.transaction_type || '', ba?.bank_name || '', ba?.iban || '',
        acc?.code || '', acc?.name || '', cat?.name || '',
        tx.classification_status === 'confirmed' ? 'Confermato' : 'Suggerito AI',
        tx.classification_reasoning || '',
        ff.is_tax_payment ? 'Si' : '', ff.tax_type || '',
        'Diretto',
      ])
    }

    // Commissioni da riconciliazioni
    for (const rec of (commissions || [])) {
      const btx = rec.bank_transaction as any
      if (!btx || !btx.commission_amount || btx.commission_amount <= 0) continue
      const ba = btx.bank_account as any
      bankRows.push([
        fmtDateIT(btx.date), fmtNum(-Math.abs(btx.commission_amount)),
        'Uscita',
        btx.counterparty_name || '', 'Commissione su riconciliazione',
        btx.transaction_type || '', ba?.bank_name || '', ba?.iban || '',
        '64330', 'Spese di banca', 'Spese bancarie',
        'Confermato', rec.match_reason || '', '', '',
        'Commissione riconciliazione',
      ])
    }

    const ws2 = XLSX.utils.aoa_to_sheet(bankRows)
    applyHeaderStyle(ws2, bankHeaders.length)
    autoFitColumns(ws2, bankRows)
    ws2['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: bankRows.length - 1, c: bankHeaders.length - 1 } }) }
    ws2['!freeze'] = { xSplit: 0, ySplit: 1 }
    XLSX.utils.book_append_sheet(wb, ws2, 'Movimenti Bancari')
  }

  // ═══════════════════════════════════════
  // SHEET 3: Riconciliazioni
  // ═══════════════════════════════════════
  if (filters.includeReconciliations) {
    onProgress?.('Caricamento riconciliazioni...')

    const { data: reconciliations, error: reconErr } = await supabase
      .from('reconciliations')
      .select(`
        reconciled_amount, match_type, match_reason, confidence, confirmed_at,
        bank_transaction:bank_transactions(date, amount, counterparty_name, description, bank_account:bank_accounts(bank_name)),
        invoice:invoices(number, date, total_amount, counterparty:counterparties(name)),
        installment:invoice_installments(amount_due)
      `)
      .eq('company_id', companyId)
      .gte('confirmed_at', filters.dateFrom)
      .lte('confirmed_at', filters.dateTo + 'T23:59:59')
      .order('confirmed_at', { ascending: true })

    if (reconErr) throw reconErr

    const reconHeaders = [
      'Data Conferma', 'Metodo', 'Data Movimento', 'Importo Movimento', 'Controparte (Banca)',
      'Descrizione Movimento', 'Banca',
      'Data Fattura', 'Numero Fattura', 'Controparte (Fattura)', 'Totale Fattura',
      'Importo Rata', 'Importo Riconciliato', 'Tipo Match', 'Motivo', 'Note',
    ]
    const reconRows: any[][] = [reconHeaders]

    for (const rec of (reconciliations || [])) {
      const btx = rec.bank_transaction as any
      const inv = rec.invoice as any
      const inst = rec.installment as any
      reconRows.push([
        fmtDateIT(rec.confirmed_at?.slice(0, 10)),
        'Banca',
        fmtDateIT(btx?.date), fmtNum(btx?.amount),
        btx?.counterparty_name || '', btx?.description || '',
        btx?.bank_account?.bank_name || '',
        fmtDateIT(inv?.date), inv?.number || '',
        inv?.counterparty?.name || '', fmtNum(inv?.total_amount),
        fmtNum(inst?.amount_due), fmtNum(rec.reconciled_amount),
        rec.match_type || '', rec.match_reason || '', '',
      ])
    }

    // Add cash payments to the same sheet
    const { data: cashPayments, error: cashErr } = await supabase
      .from('cash_payments')
      .select(`
        amount, payment_date, notes, created_at,
        invoice:invoices(number, date, total_amount, counterparty:counterparties(name)),
        installment:invoice_installments(amount_due)
      `)
      .eq('company_id', companyId)
      .gte('payment_date', filters.dateFrom)
      .lte('payment_date', filters.dateTo)
      .order('payment_date', { ascending: true })

    if (cashErr) console.warn('[export] cash payments query error:', cashErr)

    for (const cp of (cashPayments || [])) {
      const inv = cp.invoice as any
      const inst = cp.installment as any
      reconRows.push([
        fmtDateIT(cp.payment_date),
        'Contanti',
        fmtDateIT(cp.payment_date), fmtNum(cp.amount),
        '', '', '',
        fmtDateIT(inv?.date), inv?.number || '',
        inv?.counterparty?.name || '', fmtNum(inv?.total_amount),
        fmtNum(inst?.amount_due), fmtNum(cp.amount),
        'cash', 'Pagamento contanti', cp.notes || '',
      ])
    }

    const ws3 = XLSX.utils.aoa_to_sheet(reconRows)
    applyHeaderStyle(ws3, reconHeaders.length)
    autoFitColumns(ws3, reconRows)
    ws3['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: reconRows.length - 1, c: reconHeaders.length - 1 } }) }
    ws3['!freeze'] = { xSplit: 0, ySplit: 1 }
    XLSX.utils.book_append_sheet(wb, ws3, 'Riconciliazioni')
  }

  // ═══════════════════════════════════════
  // SHEET 4: Riepilogo
  // ═══════════════════════════════════════
  onProgress?.('Generazione riepilogo...')

  // Aggregate counts for summary
  const { count: invPassiveCount } = await supabase
    .from('invoices').select('id', { count: 'exact', head: true })
    .eq('company_id', companyId).eq('direction', 'in')
    .gte('date', filters.dateFrom).lte('date', filters.dateTo)

  const { count: invActiveCount } = await supabase
    .from('invoices').select('id', { count: 'exact', head: true })
    .eq('company_id', companyId).eq('direction', 'out')
    .gte('date', filters.dateFrom).lte('date', filters.dateTo)

  const { data: totals } = await supabase
    .from('invoices')
    .select('direction, total_amount')
    .eq('company_id', companyId)
    .gte('date', filters.dateFrom)
    .lte('date', filters.dateTo)

  const totalPassive = (totals || []).filter(i => i.direction === 'in').reduce((s, i) => s + Number(i.total_amount || 0), 0)
  const totalActive = (totals || []).filter(i => i.direction === 'out').reduce((s, i) => s + Number(i.total_amount || 0), 0)

  const { count: bankNoInvCount } = await supabase
    .from('bank_transactions').select('id', { count: 'exact', head: true })
    .eq('company_id', companyId).eq('tx_nature', 'no_invoice')
    .gte('date', filters.dateFrom).lte('date', filters.dateTo)

  const { count: reconCount } = await supabase
    .from('reconciliations').select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .gte('confirmed_at', filters.dateFrom)
    .lte('confirmed_at', filters.dateTo + 'T23:59:59')

  const { count: unmatchedCount } = await supabase
    .from('bank_transactions').select('id', { count: 'exact', head: true })
    .eq('company_id', companyId).eq('reconciliation_status', 'unmatched')
    .gte('date', filters.dateFrom).lte('date', filters.dateTo)

  const { count: cashPaymentCount } = await supabase
    .from('cash_payments').select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .gte('payment_date', filters.dateFrom).lte('payment_date', filters.dateTo)

  const summaryRows: any[][] = [
    ['Riepilogo Export FinFlow'],
    [],
    ['Periodo', `${fmtDateIT(filters.dateFrom)} - ${fmtDateIT(filters.dateTo)}`],
    ['Azienda', companyName],
    [],
    ['Fatture passive (ricevute)', invPassiveCount || 0, 'Totale', fmtNum(totalPassive)],
    ['Fatture attive (emesse)', invActiveCount || 0, 'Totale', fmtNum(totalActive)],
    [],
    ['Movimenti bancari senza fattura', bankNoInvCount || 0],
    ['Riconciliazioni confermate', reconCount || 0],
    ['Pagamenti in contanti', cashPaymentCount || 0],
    ['Movimenti non riconciliati', unmatchedCount || 0],
  ]

  const ws4 = XLSX.utils.aoa_to_sheet(summaryRows)
  ws4['!cols'] = [{ wch: 35 }, { wch: 12 }, { wch: 10 }, { wch: 15 }]
  // Style title row
  const titleCell = ws4['A1']
  if (titleCell) {
    titleCell.s = { font: { bold: true, sz: 14, color: { rgb: '1e40af' } } }
  }
  XLSX.utils.book_append_sheet(wb, ws4, 'Riepilogo')

  // ═══════════════════════════════════════
  // Generate and download
  // ═══════════════════════════════════════
  onProgress?.('Generazione file Excel...')

  const dfrom = filters.dateFrom.replace(/-/g, '')
  const dto = filters.dateTo.replace(/-/g, '')
  const safeName = companyName.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)
  const filename = `FinFlow_Export_${safeName}_${dfrom}_${dto}.xlsx`

  XLSX.writeFile(wb, filename, { bookType: 'xlsx' })
}
