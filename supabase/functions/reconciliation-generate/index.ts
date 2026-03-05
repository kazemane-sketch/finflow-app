import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_BATCH = 100;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/* ─── types ────────────────────────────── */

interface TxRow {
  id: string;
  date: string;
  amount: number;
  counterparty_name: string | null;
  transaction_type: string | null;
  extracted_refs: Record<string, unknown> | null;
  raw_text: string | null;
  direction: string;
  reconciled_amount: number;
}

interface Suggestion {
  bank_transaction_id: string;
  installment_id: string | null;
  invoice_id: string | null;
  match_score: number;
  match_reason: string;
  proposed_by: "deterministic" | "rule" | "ai";
  rule_id: string | null;
  suggestion_data: Record<string, unknown> | null;
}

type SqlClient = ReturnType<typeof postgres>;

/* ─── ref extraction helpers ──────────── */

/**
 * Normalize all the different field names the AI extraction uses for invoice refs.
 * The Anthropic extraction produces inconsistent schemas across batches:
 *   - `invoice_refs` (array) — the canonical name
 *   - `numeri_fattura` (array) — Italian plural
 *   - `numero_fattura` (string or array) — Italian singular
 *   - `fatture` (array)
 *   - `riferimenti_fattura` (array)
 */
function extractInvoiceRefs(refs: Record<string, unknown> | null): string[] {
  if (!refs) return [];
  // Don't process error records
  if (typeof refs.error === "string") return [];

  const results: string[] = [];

  // Array fields
  const arrayFields = [
    "invoice_refs",
    "numeri_fattura",
    "fatture",
    "riferimenti_fattura",
  ];
  for (const field of arrayFields) {
    const val = refs[field];
    if (Array.isArray(val)) {
      for (const v of val) {
        if (typeof v === "string" && v.length >= 2) results.push(v.trim());
      }
    }
  }

  // Single-string fields
  for (const field of ["numero_fattura"]) {
    const val = refs[field];
    if (typeof val === "string" && val.length >= 2) results.push(val.trim());
  }

  return [...new Set(results)];
}

/**
 * Normalize all the different field names for mandate SDD IDs.
 *   - `mandate_id` (string) — canonical
 *   - `codice_mandato_sdd` (string)
 *   - `mandato_sdd` (string)
 *   - `codici_mandato_sdd` (array)
 */
function extractMandateId(refs: Record<string, unknown> | null): string | null {
  if (!refs) return null;
  if (typeof refs.error === "string") return null;

  for (const field of ["mandate_id", "codice_mandato_sdd", "mandato_sdd"]) {
    const val = refs[field];
    if (typeof val === "string" && val.length >= 3) return val;
  }
  for (const field of ["codici_mandato_sdd"]) {
    const val = refs[field];
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === "string") {
      return val[0];
    }
  }
  return null;
}

/**
 * Parse raw_text for invoice references when AI extraction didn't capture them.
 * Handles common MPS bank statement formats:
 *   - "RI: 381/FE/25 377/FE/25 ... CAUS:"
 *   - "Fattura num. 5250425719 del 10/11/2025"
 *   - "RIF.FATT: FATTURA N. 193 DEL 31-12-2024"
 *   - "SALDO FATTURA N. 309 DEL 16 FEBBRAIO 2026"
 *   - Standalone XXX/FE/YY patterns
 */
function parseRawTextForRefs(rawText: string | null): string[] {
  if (!rawText) return [];
  const refs: string[] = [];

  // Pattern 1: "RI: 381/FE/25 377/FE/25..." — multiple refs after RI:
  for (const m of rawText.matchAll(/RI:\s*([\d\/\w\s]+?)(?:CAUS|$)/gi)) {
    const chunk = m[1].trim();
    for (const part of chunk.split(/\s+/)) {
      if (/^\d+\/\w+\/\d{2,4}$/.test(part)) {
        refs.push(part);
      }
    }
  }

  // Pattern 2: Standalone XXX/FE/YY patterns (if not already captured)
  for (const m of rawText.matchAll(/(\d+\/FE\/\d{2,4})/gi)) {
    refs.push(m[1]);
  }

  // Pattern 3: "Fattura num. XXXX" / "Fatt. n. XXXX"
  for (const m of rawText.matchAll(
    /(?:Fattura|Fatt\.?)\s+(?:num\.?|n\.?)\s*(\S+)/gi,
  )) {
    refs.push(m[1].replace(/[,;.]$/, ""));
  }

  // Pattern 4: "RIF.FATT: FATTURA N. XXX"
  for (const m of rawText.matchAll(
    /RIF\.?FATT[.:]\s*FATTURA\s+N\.?\s*(\S+)/gi,
  )) {
    refs.push(m[1].replace(/[,;.]$/, ""));
  }

  // Pattern 5: "SALDO FATTURA N. XXX DEL..."
  for (const m of rawText.matchAll(/SALDO\s+FATTURA\s+N\.?\s*(\S+)/gi)) {
    refs.push(m[1].replace(/[,;.]$/, ""));
  }

  return [...new Set(refs)].filter((r) => r.length >= 2);
}

/* ─── Level 1: Match by invoice refs (highest confidence) ─── */

async function matchByInvoiceRefs(
  sql: SqlClient,
  companyId: string,
  tx: TxRow,
  invoiceRefs: string[],
  remainingAmount: number,
): Promise<Suggestion[]> {
  const suggestions: Suggestion[] = [];

  for (const ref of invoiceRefs) {
    if (!ref || ref.length < 2) continue;

    // Extract numeric-only part for flexible matching
    const numericPart = ref.replace(/[^0-9]/g, "");

    const matches = await sql.unsafe(
      `SELECT i.id as invoice_id, i.number, i.total_amount,
              ii.id as installment_id, ii.amount_due, ii.paid_amount, ii.due_date, ii.status
       FROM invoices i
       LEFT JOIN invoice_installments ii
         ON ii.invoice_id = i.id AND ii.status IN ('pending','overdue','partial')
       WHERE i.company_id = $1
         AND (
           i.number = $2
           OR i.number ILIKE '%' || $2 || '%'
           OR $2 ILIKE '%' || i.number || '%'
           OR (length($3) >= 3 AND i.number ILIKE '%' || $3 || '%')
         )
       ORDER BY i.date DESC
       LIMIT 10`,
      [companyId, ref, numericPart],
    );

    for (const m of matches) {
      const instRemaining = m.installment_id
        ? Math.abs(Number(m.amount_due) - Number(m.paid_amount || 0))
        : Math.abs(Number(m.total_amount));

      // Skip fully paid installments
      if (m.installment_id && instRemaining < 0.01) continue;

      const amountDiff = Math.abs(remainingAmount - instRemaining);
      const amountRatio =
        remainingAmount > 0 ? amountDiff / remainingAmount : 1;

      // Base score is HIGH because we have explicit ref match
      let score = 92;
      let reason = `Riferimento fattura "${ref}" nel testo operazione \u2192 Fatt. ${m.number}`;

      if (amountRatio < 0.05) {
        score = 98;
        reason += " + importo corrispondente";
      } else if (amountRatio < 0.15) {
        score = 95;
        reason += ` (diff \u20AC${amountDiff.toFixed(2)})`;
      }

      suggestions.push({
        bank_transaction_id: tx.id,
        installment_id: m.installment_id || null,
        invoice_id: m.invoice_id,
        match_score: score,
        match_reason: reason,
        proposed_by: "deterministic",
        rule_id: null,
        suggestion_data: {
          ref,
          amount_diff: amountDiff,
          level: "invoice_ref",
        },
      });
    }
  }

  return suggestions;
}

/* ─── Level 2: Match by mandate SDD (recurring payments) ─── */

async function matchByMandate(
  sql: SqlClient,
  companyId: string,
  tx: TxRow,
  mandateId: string,
  remainingAmount: number,
): Promise<Suggestion[]> {
  const suggestions: Suggestion[] = [];

  // Find counterparty from other transactions with same mandate
  const mandateMatches = await sql.unsafe(
    `SELECT DISTINCT counterparty_name
     FROM bank_transactions
     WHERE company_id = $1
       AND counterparty_name IS NOT NULL
       AND (
         extracted_refs->>'mandate_id' = $2
         OR extracted_refs->>'codice_mandato_sdd' = $2
         OR extracted_refs->'codici_mandato_sdd' @> to_jsonb($2::text)
       )
     LIMIT 3`,
    [companyId, mandateId],
  );

  if (mandateMatches.length === 0) return [];

  const cpName = mandateMatches[0].counterparty_name;
  const cpWord = cpName.split(/\s+/)[0];
  if (!cpWord || cpWord.length < 3) return [];

  const openInst = await sql.unsafe(
    `SELECT ii.id as installment_id, ii.invoice_id, ii.due_date,
            ii.amount_due, ii.paid_amount,
            inv.number as invoice_number,
            inv.counterparty->>'denom' as counterparty_name
     FROM invoice_installments ii
     JOIN invoices inv ON inv.id = ii.invoice_id
     WHERE ii.company_id = $1
       AND ii.status IN ('pending','overdue','partial')
       AND inv.counterparty->>'denom' ILIKE '%' || $2 || '%'
       AND abs(ii.amount_due - ii.paid_amount) BETWEEN $3 * 0.85 AND $3 * 1.15
     ORDER BY abs(abs(ii.amount_due - ii.paid_amount) - $3) ASC
     LIMIT 5`,
    [companyId, cpWord, remainingAmount],
  );

  for (const m of openInst) {
    const instRemaining = Math.abs(
      Number(m.amount_due) - Number(m.paid_amount),
    );
    if (instRemaining < 0.01) continue;
    const amountDiff = Math.abs(remainingAmount - instRemaining);

    suggestions.push({
      bank_transaction_id: tx.id,
      installment_id: m.installment_id,
      invoice_id: m.invoice_id,
      match_score: 85,
      match_reason: `Mandato SDD "${mandateId}" \u2192 controparte ${cpName} + importo simile`,
      proposed_by: "deterministic",
      rule_id: null,
      suggestion_data: {
        mandate_id: mandateId,
        counterparty: cpName,
        amount_diff: amountDiff,
        level: "mandate",
      },
    });
  }

  return suggestions;
}

/* ─── Level 3: Fallback — counterparty + amount ─── */

async function matchByCounterpartyAmount(
  sql: SqlClient,
  companyId: string,
  tx: TxRow,
  remainingAmount: number,
): Promise<Suggestion[]> {
  const suggestions: Suggestion[] = [];

  if (!tx.counterparty_name) return [];
  const cpWord = tx.counterparty_name.split(/\s+/)[0];
  if (!cpWord || cpWord.length < 3) return [];

  const cpMatches = await sql.unsafe(
    `SELECT ii.id as installment_id, ii.invoice_id, ii.due_date,
            ii.amount_due, ii.paid_amount, ii.status, ii.direction,
            inv.number as invoice_number,
            inv.counterparty->>'denom' as counterparty_name
     FROM invoice_installments ii
     JOIN invoices inv ON inv.id = ii.invoice_id
     WHERE ii.company_id = $1
       AND ii.status IN ('pending','overdue','partial')
       AND inv.counterparty->>'denom' ILIKE '%' || $2 || '%'
       AND abs(ii.amount_due - ii.paid_amount) BETWEEN $3 * 0.90 AND $3 * 1.10
     ORDER BY abs(abs(ii.amount_due - ii.paid_amount) - $3) ASC
     LIMIT 5`,
    [companyId, cpWord, remainingAmount],
  );

  for (const m of cpMatches) {
    const instRemaining = Math.abs(
      Number(m.amount_due) - Number(m.paid_amount),
    );
    if (instRemaining < 0.01) continue;
    const amountDiff = Math.abs(remainingAmount - instRemaining);
    const amountRatio =
      remainingAmount > 0 ? amountDiff / remainingAmount : 1;
    const daysDiff =
      tx.date && m.due_date
        ? Math.abs(
            (new Date(tx.date).getTime() - new Date(m.due_date).getTime()) /
              86400000,
          )
        : 999;

    let score = 65;
    if (amountRatio < 0.05 && daysDiff < 30) score = 85;
    else if (amountRatio < 0.05 && daysDiff < 60) score = 80;
    else if (amountRatio < 0.10 && daysDiff < 30) score = 75;
    else if (amountRatio < 0.10) score = 70;

    suggestions.push({
      bank_transaction_id: tx.id,
      installment_id: m.installment_id,
      invoice_id: m.invoice_id,
      match_score: score,
      match_reason: `Controparte "${m.counterparty_name}" + importo simile (diff \u20AC${amountDiff.toFixed(2)})${daysDiff < 30 ? " + data vicina" : ""}`,
      proposed_by: "deterministic",
      rule_id: null,
      suggestion_data: {
        counterparty: m.counterparty_name,
        amount_diff: amountDiff,
        days_diff: daysDiff,
        level: "counterparty",
      },
    });
  }

  return suggestions;
}

/* ─── dedup helper ────────────────────── */

function dedup(suggestions: Suggestion[], maxResults: number): Suggestion[] {
  const seen = new Set<string>();
  return suggestions
    .filter((s) => {
      const key = `${s.installment_id || ""}:${s.invoice_id || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, maxResults);
}

/* ─── main generator per transaction ──── */

async function generateForTransaction(
  sql: SqlClient,
  companyId: string,
  tx: TxRow,
): Promise<Suggestion[]> {
  const absAmount = Math.abs(Number(tx.amount));
  const remainingAmount = absAmount - Number(tx.reconciled_amount || 0);
  if (remainingAmount < 0.01) return [];

  // ── Normalize refs from the inconsistent AI extraction schemas ──
  let invoiceRefs = extractInvoiceRefs(tx.extracted_refs);
  const mandateId = extractMandateId(tx.extracted_refs);

  // ── Fallback: parse raw_text if no refs were extracted ──
  if (invoiceRefs.length === 0) {
    invoiceRefs = parseRawTextForRefs(tx.raw_text);
  }

  // ── Level 1: Match by invoice refs (highest priority, score 92-98) ──
  if (invoiceRefs.length > 0) {
    const refMatches = await matchByInvoiceRefs(
      sql,
      companyId,
      tx,
      invoiceRefs,
      remainingAmount,
    );
    if (refMatches.length > 0) {
      // Found ref matches — return them, don't fall through to lower levels
      return dedup(refMatches, 20);
    }
  }

  // ── Level 2: Match by mandate SDD (score 85) ──
  if (mandateId) {
    const mandateMatches = await matchByMandate(
      sql,
      companyId,
      tx,
      mandateId,
      remainingAmount,
    );
    if (mandateMatches.length > 0) {
      return dedup(mandateMatches, 5);
    }
  }

  // ── Level 3: Fallback — counterparty + amount (score 65-85) ──
  const fallback = await matchByCounterpartyAmount(
    sql,
    companyId,
    tx,
    remainingAmount,
  );
  return dedup(fallback, 5);
}

/* ─── main handler ────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")
    return json({ error: "Method not allowed" }, 405);

  const dbUrl = (Deno.env.get("SUPABASE_DB_URL") ?? "").trim();
  if (!dbUrl) return json({ error: "SUPABASE_DB_URL non configurato" }, 503);

  let body: { company_id?: string; batch_size?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body JSON non valido" }, 400);
  }

  const companyId = body.company_id;
  if (!companyId) return json({ error: "company_id richiesto" }, 400);

  const batchSize = Math.min(Math.max(body.batch_size ?? 50, 1), MAX_BATCH);
  const sql = postgres(dbUrl, { max: 1 });

  try {
    // Get unmatched/partial transactions — include raw_text for fallback parsing.
    // Don't require extraction_status='ready' since raw_text parsing works on any TX.
    // Prioritize 'ready' transactions (they have AI-extracted refs) first.
    const rows: TxRow[] = await sql`
      SELECT id, date, amount, counterparty_name, transaction_type,
             extracted_refs, raw_text, direction, reconciled_amount
      FROM bank_transactions
      WHERE company_id = ${companyId}
        AND reconciliation_status IN ('unmatched', 'partial')
        AND abs(amount) - reconciled_amount > 0.01
        AND id NOT IN (
          SELECT DISTINCT bank_transaction_id
          FROM reconciliation_suggestions
          WHERE company_id = ${companyId} AND status = 'pending'
        )
      ORDER BY
        CASE WHEN extraction_status = 'ready' THEN 0 ELSE 1 END,
        date DESC
      LIMIT ${batchSize}
    `;

    let totalSuggestions = 0;
    let txProcessed = 0;

    for (const tx of rows) {
      const suggestions = await generateForTransaction(sql, companyId, tx);

      for (const s of suggestions) {
        if (s.match_score < 50) continue;

        await sql`
          INSERT INTO reconciliation_suggestions
            (company_id, bank_transaction_id, installment_id, invoice_id,
             match_score, match_reason, proposed_by, rule_id, suggestion_data)
          VALUES
            (${companyId}, ${s.bank_transaction_id}, ${s.installment_id}, ${s.invoice_id},
             ${s.match_score}, ${s.match_reason}, ${s.proposed_by}, ${s.rule_id},
             ${s.suggestion_data ? JSON.stringify(s.suggestion_data) : null}::jsonb)
        `;
        totalSuggestions++;
      }
      txProcessed++;
    }

    // Count totals (include partial in unmatched count for display)
    const [{ pending_count }] = await sql`
      SELECT count(*)::int as pending_count
      FROM reconciliation_suggestions
      WHERE company_id = ${companyId} AND status = 'pending'
    `;

    const [{ unmatched_count }] = await sql`
      SELECT count(*)::int as unmatched_count
      FROM bank_transactions
      WHERE company_id = ${companyId}
        AND reconciliation_status IN ('unmatched', 'partial')
    `;

    const [{ matched_count }] = await sql`
      SELECT count(*)::int as matched_count
      FROM bank_transactions
      WHERE company_id = ${companyId} AND reconciliation_status = 'matched'
    `;

    return json({
      processed: txProcessed,
      new_suggestions: totalSuggestions,
      totals: {
        pending_suggestions: pending_count,
        unmatched_transactions: unmatched_count,
        matched_transactions: matched_count,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[reconciliation-generate] Error:", msg);
    return json({ error: msg }, 500);
  } finally {
    await sql.end();
  }
});
