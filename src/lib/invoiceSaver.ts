import { supabase } from '@/integrations/supabase/client'
import type { ParseResult } from './invoiceParser'

interface SaveResult {
  fn: string
  success: boolean
  invoiceId?: string
  error?: string
}

export async function saveInvoicesToDB(
  results: ParseResult[],
  companyId: string
): Promise<SaveResult[]> {
  const saveResults: SaveResult[] = []

  for (const r of results) {
    if (r.err || !r.data) {
      saveResults.push({ fn: r.fn, success: false, error: r.err || 'Nessun dato' })
      continue
    }

    try {
      const d = r.data
      const b = d.bodies[0]
      if (!b) throw new Error('Nessun body nella fattura')

      // Determine direction: if our company is CessionarioCommittente → incoming (in)
      // For now assume all imported invoices are incoming (received from suppliers)
      const direction = 'in'

      // Find or create counterparty (fornitore = CedentePrestatore)
      const counterpartyId = await findOrCreateCounterparty(companyId, {
        name: d.ced.denom,
        vatNumber: d.ced.piva?.replace(/^IT/, ''),
        fiscalCode: d.ced.cf,
        address: d.ced.sede,
        email: d.ced.email,
        phone: d.ced.tel,
      })

      // Extract payment due date from first payment detail
      const paymentDueDate = b.pagamenti?.[0]?.scadenza || null

      // Check for duplicate (same number + date + counterparty)
      const { data: existing } = await supabase
        .from('invoices')
        .select('id')
        .eq('company_id', companyId)
        .eq('number', b.numero)
        .eq('date', b.data)
        .eq('counterparty_id', counterpartyId)
        .limit(1)

      if (existing && existing.length > 0) {
        saveResults.push({ fn: r.fn, success: true, invoiceId: existing[0].id, error: 'Duplicato (già importata)' })
        continue
      }

      // Calculate tax totals from riepilogo
      const taxableAmount = b.riepilogo?.reduce((s, r) => s + parseFloat(r.imponibile || '0'), 0) || null
      const taxAmount = b.riepilogo?.reduce((s, r) => s + parseFloat(r.imposta || '0'), 0) || null

      // Insert invoice
      const { data: invoice, error: invError } = await supabase
        .from('invoices')
        .insert({
          company_id: companyId,
          counterparty_id: counterpartyId,
          direction,
          doc_type: b.tipo,
          number: b.numero,
          date: b.data,
          currency: b.divisa || 'EUR',
          total_amount: parseFloat(b.totale) || 0,
          taxable_amount: taxableAmount,
          tax_amount: taxAmount,
          withholding_amount: b.ritenuta?.importo ? parseFloat(b.ritenuta.importo) : null,
          stamp_amount: b.bollo?.importo ? parseFloat(b.bollo.importo) : null,
          payment_method: b.pagamenti?.[0]?.modalita || null,
          payment_terms: b.condPag || null,
          payment_due_date: paymentDueDate || null,
          payment_status: paymentDueDate ? (new Date(paymentDueDate) < new Date() ? 'overdue' : 'pending') : 'pending',
          notes: b.causali?.join('\n') || null,
          raw_xml: r.rawXml,
          xml_version: d.ver,
          parse_method: r.method,
          source_filename: r.fn,
        })
        .select()
        .single()

      if (invError) throw new Error(invError.message)

      // Insert invoice lines
      if (b.linee?.length > 0) {
        const lines = b.linee.map(l => ({
          invoice_id: invoice.id,
          line_number: l.numero ? parseInt(l.numero) : null,
          description: l.descrizione,
          quantity: l.quantita ? parseFloat(l.quantita) : null,
          unit_measure: l.unitaMisura || null,
          unit_price: l.prezzoUnitario ? parseFloat(l.prezzoUnitario) : null,
          total_price: l.prezzoTotale ? parseFloat(l.prezzoTotale) : null,
          vat_rate: l.aliquotaIVA ? parseFloat(l.aliquotaIVA) : null,
          vat_nature: l.natura || null,
          article_code: l.codiceArticolo || null,
        }))

        const { error: linesError } = await supabase
          .from('invoice_lines')
          .insert(lines)

        if (linesError) console.warn('Errore inserimento linee:', linesError.message)
      }

      saveResults.push({ fn: r.fn, success: true, invoiceId: invoice.id })
    } catch (e: any) {
      saveResults.push({ fn: r.fn, success: false, error: e.message })
    }
  }

  return saveResults
}

async function findOrCreateCounterparty(
  companyId: string,
  data: {
    name: string
    vatNumber?: string
    fiscalCode?: string
    address?: string
    email?: string
    phone?: string
  }
): Promise<string> {
  // Try to find by VAT number first
  if (data.vatNumber) {
    const { data: existing } = await supabase
      .from('counterparties')
      .select('id')
      .eq('company_id', companyId)
      .eq('vat_number', data.vatNumber)
      .limit(1)

    if (existing && existing.length > 0) return existing[0].id
  }

  // Try by fiscal code
  if (data.fiscalCode) {
    const { data: existing } = await supabase
      .from('counterparties')
      .select('id')
      .eq('company_id', companyId)
      .eq('fiscal_code', data.fiscalCode)
      .limit(1)

    if (existing && existing.length > 0) return existing[0].id
  }

  // Try by name (exact match)
  if (data.name) {
    const { data: existing } = await supabase
      .from('counterparties')
      .select('id')
      .eq('company_id', companyId)
      .eq('name', data.name)
      .limit(1)

    if (existing && existing.length > 0) return existing[0].id
  }

  // Parse address
  const parts = data.address?.split(',').map(s => s.trim()) || []
  const address = parts[0] || null
  const cityPart = parts[1] || ''
  const cityMatch = cityPart.match(/^(\d{5})?\s*(.+?)(?:\s*\((\w{2})\))?$/)

  // Create new counterparty
  const { data: newCp, error } = await supabase
    .from('counterparties')
    .insert({
      company_id: companyId,
      type: 'supplier',
      name: data.name,
      vat_number: data.vatNumber || null,
      fiscal_code: data.fiscalCode || null,
      address: address,
      zip: cityMatch?.[1] || null,
      city: cityMatch?.[2] || null,
      province: cityMatch?.[3] || null,
      email: data.email || null,
      phone: data.phone || null,
      auto_created: true,
    })
    .select('id')
    .single()

  if (error) throw new Error('Errore creazione fornitore: ' + error.message)
  return newCp.id
}

// Load invoices from DB
export interface DBInvoice {
  id: string
  doc_type: string
  number: string
  date: string
  total_amount: number
  currency: string
  payment_status: string
  payment_due_date: string | null
  reconciliation_status: string
  direction: string
  source_filename: string | null
  counterparty: { id: string; name: string; vat_number: string | null } | null
}

export async function loadInvoices(companyId: string): Promise<DBInvoice[]> {
  const { data, error } = await supabase
    .from('invoices')
    .select(`
      id, doc_type, number, date, total_amount, currency,
      payment_status, payment_due_date, reconciliation_status,
      direction, source_filename,
      counterparty:counterparties(id, name, vat_number)
    `)
    .eq('company_id', companyId)
    .order('date', { ascending: false })

  if (error) throw new Error(error.message)
  return (data || []) as unknown as DBInvoice[]
}

// Load single invoice with lines
export interface DBInvoiceDetail {
  id: string
  doc_type: string
  number: string
  date: string
  total_amount: number
  taxable_amount: number | null
  tax_amount: number | null
  withholding_amount: number | null
  stamp_amount: number | null
  currency: string
  payment_method: string | null
  payment_terms: string | null
  payment_status: string
  payment_due_date: string | null
  reconciliation_status: string
  direction: string
  notes: string | null
  raw_xml: string | null
  xml_version: string | null
  parse_method: string | null
  source_filename: string | null
  counterparty: { id: string; name: string; vat_number: string | null; fiscal_code: string | null; address: string | null; city: string | null; province: string | null; email: string | null } | null
  invoice_lines: { id: string; line_number: number | null; description: string; quantity: number | null; unit_measure: string | null; unit_price: number | null; total_price: number | null; vat_rate: number | null; vat_nature: string | null; article_code: string | null }[]
}

export async function loadInvoiceDetail(invoiceId: string): Promise<DBInvoiceDetail | null> {
  const { data, error } = await supabase
    .from('invoices')
    .select(`
      *,
      counterparty:counterparties(id, name, vat_number, fiscal_code, address, city, province, email),
      invoice_lines(id, line_number, description, quantity, unit_measure, unit_price, total_price, vat_rate, vat_nature, article_code)
    `)
    .eq('id', invoiceId)
    .single()

  if (error) return null
  return data as unknown as DBInvoiceDetail
}
