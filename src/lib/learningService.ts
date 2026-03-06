/**
 * Learning Service — Unified RAG learning examples
 *
 * Every user confirmation (article assignment, classification, reconciliation)
 * creates a learning example with a text embedding. Future AI suggestions
 * search these embeddings via pgvector (Level 2 - RAG) before falling back
 * to paid Haiku calls (Level 3).
 *
 * Pattern:
 *   1. User confirms → createXxxExample() → inserts row in learning_examples
 *   2. triggerEmbedding() → fire-and-forget POST to learning-embed edge function
 *   3. Edge functions search via search_learning_examples() SQL function
 */
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '@/integrations/supabase/client'
import { getValidAccessToken } from '@/lib/getValidAccessToken'

type LearningDomain = 'article_assignment' | 'classification' | 'reconciliation'

/* ─── Generic: insert learning example ──────────────────── */

export async function createLearningExample(
  companyId: string,
  domain: LearningDomain,
  inputText: string,
  outputLabel: string,
  metadata: Record<string, unknown>,
  sourceId?: string,
): Promise<string | null> {
  if (!inputText || inputText.length < 3) return null

  try {
    const row: Record<string, unknown> = {
      company_id: companyId,
      domain,
      input_text: inputText.slice(0, 2000), // limit size
      output_label: outputLabel.slice(0, 500),
      metadata,
    }
    if (sourceId) row.source_id = sourceId

    const { data, error } = await supabase
      .from('learning_examples')
      .upsert(row, { onConflict: 'company_id,source_id', ignoreDuplicates: false })
      .select('id')
      .single()

    if (error) {
      // Ignore unique constraint errors silently (duplicate source_id without the partial index match)
      if (error.code === '23505') return null
      console.warn('[learningService] createLearningExample error:', error.message)
      return null
    }
    return data?.id || null
  } catch (err) {
    console.warn('[learningService] createLearningExample exception:', err)
    return null
  }
}

/* ─── Fire-and-forget: trigger embedding generation ─────── */

export async function triggerEmbedding(exampleIds: string[], companyId: string): Promise<void> {
  if (exampleIds.length === 0) return

  try {
    const token = await getValidAccessToken()
    // Fire-and-forget: don't await the fetch response
    fetch(`${SUPABASE_URL}/functions/v1/learning-embed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        example_ids: exampleIds,
        company_id: companyId,
      }),
    }).catch(err => console.warn('[learningService] triggerEmbedding fetch error:', err))
  } catch (err) {
    console.warn('[learningService] triggerEmbedding token error:', err)
  }
}

/* ─── Domain helpers ────────────────────────────────────── */

/**
 * Create a learning example for article assignment confirmation.
 * input_text: line description + counterparty + quantity
 * output_label: article code
 */
export async function createArticleExample(
  companyId: string,
  description: string,
  counterpartyName: string | null,
  quantity: string | number | null,
  articleCode: string,
  articleName: string,
  articleId: string,
  lineId: string | null,
): Promise<string | null> {
  const inputText = `${description} | Fornitore: ${counterpartyName || 'N/D'} | Quantita: ${quantity ?? 'N/D'}`
  const metadata: Record<string, unknown> = {
    article_id: articleId,
    article_name: articleName,
  }
  if (lineId) metadata.invoice_line_id = lineId

  // source_id for dedup: use article_id + description hash
  const sourceId = `art_fb:${articleId}:${description.slice(0, 80).replace(/\s+/g, '_')}`

  const exId = await createLearningExample(companyId, 'article_assignment', inputText, articleCode, metadata, sourceId)
  if (exId) triggerEmbedding([exId], companyId)
  return exId
}

/**
 * Create a learning example for classification confirmation.
 * input_text: invoice number + counterparty + amount
 * output_label: "Category > Account Code Account Name"
 */
export async function createClassificationExample(
  companyId: string,
  invoiceNumber: string | null,
  counterpartyName: string | null,
  totalAmount: number | string | null,
  extractedSummary: string | null,
  categoryName: string | null,
  accountCode: string | null,
  accountName: string | null,
  categoryId: string | null,
  accountId: string | null,
  invoiceId: string,
): Promise<string | null> {
  const parts = [
    `Fattura N.${invoiceNumber || 'N/D'}`,
    counterpartyName || 'N/D',
    `${totalAmount || 0} EUR`,
  ]
  if (extractedSummary) parts.push(extractedSummary)
  const inputText = parts.join(' | ')

  const outputLabel = `${categoryName || ''} > ${accountCode || ''} ${accountName || ''}`.trim()
  const metadata: Record<string, unknown> = {
    category_id: categoryId,
    account_id: accountId,
    invoice_id: invoiceId,
  }

  const sourceId = `ic:${invoiceId}`

  const exId = await createLearningExample(companyId, 'classification', inputText, outputLabel, metadata, sourceId)
  if (exId) triggerEmbedding([exId], companyId)
  return exId
}

/**
 * Create a learning example for reconciliation confirmation.
 * input_text: TX description + date + amount + INV number + date + amount
 * output_label: "matched"
 */
export async function createReconciliationExample(
  companyId: string,
  txDescription: string,
  txDate: string,
  txAmount: number,
  invoiceNumber: string,
  invoiceDate: string,
  invoiceAmount: number,
  transactionId: string,
  invoiceId: string,
  installmentId: string | null,
  matchScore: number | null,
): Promise<string | null> {
  const inputText = `TX: ${txDescription} ${txDate} ${txAmount} EUR | INV: Fattura ${invoiceNumber || 'N/D'} del ${invoiceDate} ${invoiceAmount} EUR`
  const metadata: Record<string, unknown> = {
    transaction_id: transactionId,
    invoice_id: invoiceId,
    match_score: matchScore,
  }
  if (installmentId) metadata.installment_id = installmentId

  const sourceId = `rl:${transactionId}:${invoiceId}`

  const exId = await createLearningExample(companyId, 'reconciliation', inputText, 'matched', metadata, sourceId)
  if (exId) triggerEmbedding([exId], companyId)
  return exId
}
