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

/* ─── deterministic matching ─────────────── */

interface TxRow {
  id: string;
  date: string;
  amount: number;
  counterparty_name: string | null;
  transaction_type: string | null;
  extracted_refs: Record<string, unknown> | null;
  direction: string;
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

async function generateForTransaction(
  sql: SqlClient,
  companyId: string,
  tx: TxRow,
): Promise<Suggestion[]> {
  const suggestions: Suggestion[] = [];
  const absAmount = Math.abs(Number(tx.amount));
  const refs = tx.extracted_refs || {};

  // ── Level 1: Deterministic match by invoice_refs ──
  if (refs.invoice_refs && Array.isArray(refs.invoice_refs) && refs.invoice_refs.length > 0) {
    for (const ref of refs.invoice_refs as string[]) {
      if (!ref || ref.length < 2) continue;

      const matches = await sql.unsafe(
        `SELECT i.id as invoice_id, i.number, i.total_amount,
                ii.id as installment_id, ii.amount_due, ii.paid_amount, ii.due_date, ii.status
         FROM invoices i
         LEFT JOIN invoice_installments ii ON ii.invoice_id = i.id AND ii.status IN ('pending','overdue','partial')
         WHERE i.company_id = $1 AND i.number ILIKE '%' || $2 || '%'
         ORDER BY i.date DESC LIMIT 5`,
        [companyId, ref],
      );

      for (const m of matches) {
        const compareAmount = m.installment_id
          ? Math.abs(Number(m.amount_due) - Number(m.paid_amount || 0))
          : Math.abs(Number(m.total_amount));
        const amountDiff = Math.abs(absAmount - compareAmount);
        const amountRatio = absAmount > 0 ? amountDiff / absAmount : 1;

        let score = 70;
        let reason = `Riferimento fattura "${ref}" nel testo operazione`;

        if (amountRatio < 0.05) {
          score = 95;
          reason += " + importo corrispondente";
        } else if (amountRatio < 0.10) {
          score = 80;
          reason += ` (importo differisce di €${amountDiff.toFixed(2)})`;
        }

        suggestions.push({
          bank_transaction_id: tx.id,
          installment_id: m.installment_id || null,
          invoice_id: m.invoice_id,
          match_score: score,
          match_reason: reason,
          proposed_by: "deterministic",
          rule_id: null,
          suggestion_data: { ref, amount_diff: amountDiff },
        });
      }
    }
  }

  // ── Level 1b: Match by counterparty + amount ──
  if (tx.counterparty_name && suggestions.length < 3) {
    // Use first word of counterparty for broader match
    const cpWord = tx.counterparty_name.split(/\s+/)[0];
    if (cpWord && cpWord.length >= 3) {
      const cpMatches = await sql.unsafe(
        `SELECT ii.id as installment_id, ii.invoice_id, ii.due_date, ii.amount_due, ii.paid_amount,
                ii.status, ii.direction, inv.number as invoice_number,
                inv.counterparty->>'denom' as counterparty_name
         FROM invoice_installments ii
         JOIN invoices inv ON inv.id = ii.invoice_id
         WHERE ii.company_id = $1
           AND ii.status IN ('pending','overdue','partial')
           AND inv.counterparty->>'denom' ILIKE '%' || $2 || '%'
           AND abs(ii.amount_due - ii.paid_amount) BETWEEN $3 * 0.90 AND $3 * 1.10
         ORDER BY abs(abs(ii.amount_due - ii.paid_amount) - $3) ASC
         LIMIT 5`,
        [companyId, cpWord, absAmount],
      );

      for (const m of cpMatches) {
        // Skip if already suggested by ref match
        if (suggestions.some((s) => s.installment_id === m.installment_id)) continue;

        const remaining = Math.abs(Number(m.amount_due) - Number(m.paid_amount));
        const amountDiff = Math.abs(absAmount - remaining);
        const amountRatio = absAmount > 0 ? amountDiff / absAmount : 1;
        const daysDiff = tx.date && m.due_date
          ? Math.abs((new Date(tx.date).getTime() - new Date(m.due_date).getTime()) / 86400000)
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
          match_reason: `Controparte "${m.counterparty_name}" + importo simile (diff €${amountDiff.toFixed(2)})${daysDiff < 30 ? " + data vicina" : ""}`,
          proposed_by: "deterministic",
          rule_id: null,
          suggestion_data: { counterparty: m.counterparty_name, amount_diff: amountDiff, days_diff: daysDiff },
        });
      }
    }
  }

  // ── Level 1c: Match by mandate_id pattern ──
  if (refs.mandate_id && typeof refs.mandate_id === "string") {
    // Find other transactions with same mandate → identify the counterparty pattern
    const mandateMatches = await sql.unsafe(
      `SELECT DISTINCT counterparty_name
       FROM bank_transactions
       WHERE company_id = $1 AND extracted_refs->>'mandate_id' = $2
         AND counterparty_name IS NOT NULL
       LIMIT 3`,
      [companyId, refs.mandate_id],
    );

    if (mandateMatches.length > 0) {
      const cpName = mandateMatches[0].counterparty_name;
      const openInstallments = await sql.unsafe(
        `SELECT ii.id as installment_id, ii.invoice_id, ii.due_date, ii.amount_due, ii.paid_amount,
                inv.number as invoice_number, inv.counterparty->>'denom' as counterparty_name
         FROM invoice_installments ii
         JOIN invoices inv ON inv.id = ii.invoice_id
         WHERE ii.company_id = $1
           AND ii.status IN ('pending','overdue','partial')
           AND inv.counterparty->>'denom' ILIKE '%' || $2 || '%'
           AND abs(ii.amount_due - ii.paid_amount) BETWEEN $3 * 0.85 AND $3 * 1.15
         ORDER BY abs(abs(ii.amount_due - ii.paid_amount) - $3) ASC
         LIMIT 3`,
        [companyId, cpName.split(/\s+/)[0], absAmount],
      );

      for (const m of openInstallments) {
        if (suggestions.some((s) => s.installment_id === m.installment_id)) continue;

        const remaining = Math.abs(Number(m.amount_due) - Number(m.paid_amount));
        const amountDiff = Math.abs(absAmount - remaining);

        suggestions.push({
          bank_transaction_id: tx.id,
          installment_id: m.installment_id,
          invoice_id: m.invoice_id,
          match_score: 80,
          match_reason: `Stesso mandato SDD "${refs.mandate_id}" → controparte ${cpName}`,
          proposed_by: "deterministic",
          rule_id: null,
          suggestion_data: { mandate_id: refs.mandate_id, counterparty: cpName, amount_diff: amountDiff },
        });
      }
    }
  }

  // Deduplicate and sort
  const seen = new Set<string>();
  return suggestions
    .filter((s) => {
      const key = `${s.installment_id || ""}:${s.invoice_id || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, 5);
}

/* ─── main handler ────────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

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
    // Get unmatched transactions with extracted refs ready
    const rows: TxRow[] = await sql`
      SELECT id, date, amount, counterparty_name, transaction_type, extracted_refs, direction
      FROM bank_transactions
      WHERE company_id = ${companyId}
        AND reconciliation_status = 'unmatched'
        AND extraction_status = 'ready'
        AND id NOT IN (
          SELECT DISTINCT bank_transaction_id
          FROM reconciliation_suggestions
          WHERE company_id = ${companyId} AND status = 'pending'
        )
      ORDER BY date DESC
      LIMIT ${batchSize}
    `;

    let totalSuggestions = 0;
    let txProcessed = 0;

    for (const tx of rows) {
      const suggestions = await generateForTransaction(sql, companyId, tx);

      for (const s of suggestions) {
        if (s.match_score < 50) continue; // Skip low-confidence

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

    // Count totals
    const [{ pending_count }] = await sql`
      SELECT count(*)::int as pending_count
      FROM reconciliation_suggestions
      WHERE company_id = ${companyId} AND status = 'pending'
    `;

    const [{ unmatched_count }] = await sql`
      SELECT count(*)::int as unmatched_count
      FROM bank_transactions
      WHERE company_id = ${companyId} AND reconciliation_status = 'unmatched'
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
