import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/integrations/supabase/client'
import { useCompany } from '@/hooks/useCompany'

export interface ReconciliationBadgeData {
  /** Number of pending AI suggestions */
  pendingSuggestions: number
  /** Map of bank_transaction_id → best match_score for pending suggestions */
  txScores: Map<string, number>
  /** Set of bank_transaction_ids that are already matched */
  matchedTxIds: Set<string>
  /** Map of installment_id → best match_score */
  installmentScores: Map<string, number>
  /** Map of invoice_id → best match_score */
  invoiceScores: Map<string, number>
  /** Set of invoice_ids with at least one matched transaction */
  matchedInvoiceIds: Set<string>
  loading: boolean
  refresh: () => Promise<void>
}

export function useReconciliationBadges(): ReconciliationBadgeData {
  const { company } = useCompany()
  const companyId = company?.id || null

  const [pendingSuggestions, setPendingSuggestions] = useState(0)
  const [txScores, setTxScores] = useState<Map<string, number>>(new Map())
  const [matchedTxIds, setMatchedTxIds] = useState<Set<string>>(new Set())
  const [installmentScores, setInstallmentScores] = useState<Map<string, number>>(new Map())
  const [invoiceScores, setInvoiceScores] = useState<Map<string, number>>(new Map())
  const [matchedInvoiceIds, setMatchedInvoiceIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!companyId) return
    setLoading(true)

    try {
      // 1. Pending suggestions with scores
      const { data: suggestions } = await supabase
        .from('reconciliation_suggestions')
        .select('bank_transaction_id, installment_id, invoice_id, match_score')
        .eq('company_id', companyId)
        .eq('status', 'pending')

      const txMap = new Map<string, number>()
      const instMap = new Map<string, number>()
      const invMap = new Map<string, number>()

      for (const s of suggestions || []) {
        const txId = s.bank_transaction_id
        const score = Number(s.match_score)
        if (!txMap.has(txId) || score > txMap.get(txId)!) {
          txMap.set(txId, score)
        }
        if (s.installment_id) {
          if (!instMap.has(s.installment_id) || score > instMap.get(s.installment_id)!) {
            instMap.set(s.installment_id, score)
          }
        }
        if (s.invoice_id) {
          if (!invMap.has(s.invoice_id) || score > invMap.get(s.invoice_id)!) {
            invMap.set(s.invoice_id, score)
          }
        }
      }

      setPendingSuggestions(suggestions?.length || 0)
      setTxScores(txMap)
      setInstallmentScores(instMap)
      setInvoiceScores(invMap)

      // 2. Matched transactions
      const { data: matched } = await supabase
        .from('bank_transactions')
        .select('id')
        .eq('company_id', companyId)
        .eq('reconciliation_status', 'matched')
        .limit(2000)

      setMatchedTxIds(new Set((matched || []).map(m => m.id)))

      // 3. Matched invoices (via reconciliations table)
      const { data: recons } = await supabase
        .from('reconciliations')
        .select('invoice_id')
        .eq('company_id', companyId)
        .limit(2000)

      setMatchedInvoiceIds(new Set((recons || []).map(r => r.invoice_id)))
    } catch (err) {
      console.error('useReconciliationBadges error:', err)
    }

    setLoading(false)
  }, [companyId])

  useEffect(() => { refresh() }, [refresh])

  return {
    pendingSuggestions,
    txScores,
    matchedTxIds,
    installmentScores,
    invoiceScores,
    matchedInvoiceIds,
    loading,
    refresh,
  }
}
