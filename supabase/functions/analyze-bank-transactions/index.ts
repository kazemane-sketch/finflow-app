// analyze-bank-transactions — AI classification of unreconciled bank transactions
// Classifies unmatched transactions with accounting codes (chart of accounts, categories).
//
// SIMPLIFIED WORKFLOW (v10):
// 1. User imports invoices → classifies them
// 2. User imports bank statement
// 3. User reconciles (matches transactions to invoices)
// 4. Remaining UNMATCHED transactions → this function classifies them
//
// PRINCIPLE: produces SUGGESTIONS only (classification_status = 'ai_suggested').
// NEVER 'confirmed'. User must always confirm.

import postgres from "npm:postgres@3.4.5";
import {
  getAccountingSystemPrompt,
  getUserInstructionsBlock,
  type CompanyContext,
} from "../_shared/accounting-system-prompt.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL = "claude-sonnet-4-6";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type SqlClient = ReturnType<typeof postgres>;

/* ─── Types ─────────────────────────────── */

interface TxRow {
  id: string;
  date: string;
  amount: number;
  description: string | null;
  counterparty_name: string | null;
  transaction_type: string | null;
  raw_text: string | null;
  direction: string;
  commission_amount: number | null;
  category_code: string | null;
  reconciliation_status: string;
}

interface ClassifyResult {
  transaction_id: string;
  account_id: string | null;
  category_id: string | null;
  cost_center_id: string | null;
  confidence: number;
  reasoning: string;
  fiscal_flags: {
    is_tax_payment: boolean;
    tax_type: string | null;
    note: string | null;
  } | null;
}

interface AccountRow {
  id: string;
  code: string;
  name: string;
  section: string;
}
interface CategoryRow {
  id: string;
  name: string;
  type: string;
}
interface ProjectRow {
  id: string;
  code: string;
  name: string;
}

/* ─── Classification rules fast-path ────── */

interface ClassificationRule {
  id: string;
  description_pattern: string;
  direction: string | null;
  counterparty_vat_key: string | null;
  category_id: string | null;
  account_id: string | null;
  confidence: number;
}

function normalizeDescription(desc: string): string {
  return desc
    .toLowerCase()
    .replace(/€?\s*[\d.,]+/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/[^\w\sàèéìòùç]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function findMatchingRulesForTx(
  sql: SqlClient,
  companyId: string,
  transactions: TxRow[],
): Promise<Map<string, ClassifyResult>> {
  const rules: ClassificationRule[] = await sql`
    SELECT id, description_pattern, direction, counterparty_vat_key,
           category_id, account_id, confidence
    FROM classification_rules
    WHERE company_id = ${companyId}
      AND active = true
      AND confidence >= 60
    ORDER BY confidence DESC
  `;

  if (rules.length === 0) return new Map();

  const results = new Map<string, ClassifyResult>();

  for (const tx of transactions) {
    const normalized = normalizeDescription(tx.description || tx.raw_text || "");
    if (!normalized) continue;

    let bestRule: ClassificationRule | null = null;
    let bestLen = 0;

    for (const rule of rules) {
      if (rule.direction && rule.direction !== tx.direction) continue;
      if (
        rule.description_pattern &&
        normalized.includes(rule.description_pattern) &&
        rule.description_pattern.length > bestLen
      ) {
        bestRule = rule;
        bestLen = rule.description_pattern.length;
      }
    }

    if (bestRule && (bestRule.category_id || bestRule.account_id)) {
      results.set(tx.id, {
        transaction_id: tx.id,
        account_id: bestRule.account_id,
        category_id: bestRule.category_id,
        cost_center_id: null,
        confidence: bestRule.confidence,
        reasoning: `Regola appresa: "${bestRule.description_pattern}"`,
        fiscal_flags: null,
      });

      // Fire-and-forget: update times_applied
      sql`UPDATE classification_rules SET times_applied = times_applied + 1, last_applied_at = NOW() WHERE id = ${bestRule.id}`.catch(
        () => {},
      );
    }
  }

  return results;
}

/* ─── AI classification with shared prompt ── */

async function classifyWithAI(
  anthropicKey: string,
  transactions: TxRow[],
  accounts: AccountRow[],
  categories: CategoryRow[],
  projects: ProjectRow[],
  systemPrompt: string,
  userInstructionsBlock: string,
): Promise<ClassifyResult[]> {
  const accountList = accounts
    .filter((a) => !a.section.startsWith("assets") && !a.section.startsWith("liabilities") && !a.section.startsWith("equity"))
    .map((a) => `${a.id}: ${a.code} ${a.name} [${a.section}]`)
    .join("\n");

  // Include ALL accounts for F24 payments (debits to asset/liability accounts)
  const fullAccountList = accounts
    .map((a) => `${a.id}: ${a.code} ${a.name} [${a.section}]`)
    .join("\n");

  const catList = categories.map((c) => `${c.id}: ${c.name} (${c.type})`).join("\n");
  const cdcList = projects.map((p) => `${p.id}: ${p.code} - ${p.name}`).join("\n");

  const txList = transactions
    .map(
      (tx) =>
        `- ID: ${tx.id} | Data: ${tx.date} | Importo: €${tx.amount} | Dir: ${tx.direction} | Desc: ${(tx.description || "").slice(0, 150)} | Raw: ${(tx.raw_text || "").slice(0, 250)} | Tipo: ${tx.transaction_type || "N/D"}`,
    )
    .join("\n");

  const prompt = `${systemPrompt}
${userInstructionsBlock}

PIANO DEI CONTI (conti costo/ricavo):
${accountList}

PIANO DEI CONTI COMPLETO (per pagamenti F24 = debiti tributari/previdenziali):
${fullAccountList}

CATEGORIE:
${catList || "(nessuna categoria)"}

CENTRI DI COSTO:
${cdcList || "(nessun centro di costo)"}

MOVIMENTI BANCARI NON RICONCILIATI DA CLASSIFICARE:
${txList}

Classifica ogni movimento con il conto contabile appropriato dal piano dei conti.
Questi movimenti NON hanno una fattura associata (sono già stati esclusi dalla riconciliazione).

FORMATO RISPOSTA — SOLO JSON array. Usa gli ID uuid esatti dalla lista sopra (la parte PRIMA dei due punti):
[{"transaction_id": "uuid", "account_id": "uuid esatto dalla lista conti", "category_id": "uuid dalla lista categorie o null", "cost_center_id": "uuid dalla lista CdC o null", "confidence": 0-100, "reasoning": "codice_conto - spiegazione breve", "fiscal_flags": {"is_tax_payment": true/false, "tax_type": "IRES|IRAP|INPS|IRPEF|INAIL|Addizionale|null", "note": "eventuale nota"}}]`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(
      `Anthropic classify ${resp.status}: ${errText.slice(0, 300)}`,
    );
  }

  const data = await resp.json();
  const text =
    data?.content
      ?.filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("") || "";

  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const jsonStart = cleaned.indexOf("[");
  const jsonEnd = cleaned.lastIndexOf("]");
  if (jsonStart < 0 || jsonEnd <= jsonStart) {
    console.error("[analyze] No JSON in classify response:", cleaned.slice(0, 300));
    return [];
  }
  return JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
}

/* ─── Main handler ──────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const anthropicKey = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
  const dbUrl = (Deno.env.get("SUPABASE_DB_URL") ?? "").trim();

  if (!anthropicKey) return json({ error: "ANTHROPIC_API_KEY non configurato" }, 503);
  if (!dbUrl) return json({ error: "SUPABASE_DB_URL non configurato" }, 503);

  let body: {
    company_id?: string;
    batch_size?: number;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body JSON non valido" }, 400);
  }

  const companyId = body.company_id;
  if (!companyId) return json({ error: "company_id richiesto" }, 400);

  const batchSize = Math.min(body.batch_size || 20, 20);
  const MAX_AI_PER_BATCH = 10;
  const startTime = Date.now();

  const sql = postgres(dbUrl, { max: 1 });

  try {
    // ═══════════════════════════════════════
    // Select UNMATCHED transactions pending classification
    // ═══════════════════════════════════════

    const pendingTxs: TxRow[] = await sql`
      SELECT id, date, amount, description, counterparty_name,
             transaction_type, raw_text, direction, commission_amount,
             category_code, reconciliation_status
      FROM bank_transactions
      WHERE company_id = ${companyId}
        AND reconciliation_status = 'unmatched'
        AND classification_status = 'pending'
      ORDER BY date DESC
      LIMIT ${batchSize}
    `;

    console.log(`[analyze] Found ${pendingTxs.length} unmatched+pending transactions (limit ${batchSize})`);

    if (pendingTxs.length === 0) {
      return json({
        classified: 0,
        classified_rules: 0,
        classified_ai: 0,
        found: 0,
        elapsed_ms: Date.now() - startTime,
        classification_details: [],
      });
    }

    // ═══════════════════════════════════════
    // Fast-path: classification rules
    // ═══════════════════════════════════════

    const classificationResults: ClassifyResult[] = [];
    let classifiedRules = 0;
    let classifiedAI = 0;
    let aiRaw = 0;
    let aiSkipped = 0;

    const ruleMatches = await findMatchingRulesForTx(sql, companyId, pendingTxs);
    let needsAI: TxRow[] = [];

    for (const tx of pendingTxs) {
      const ruleResult = ruleMatches.get(tx.id);
      if (ruleResult) {
        classificationResults.push(ruleResult);
        classifiedRules++;
      } else {
        needsAI.push(tx);
      }
    }

    console.log(`[analyze] Rules: ${classifiedRules} matches, ${needsAI.length} need AI`);

    // ═══════════════════════════════════════
    // AI classification for remaining
    // ═══════════════════════════════════════

    if (needsAI.length > MAX_AI_PER_BATCH) {
      console.log(`[analyze] Capping AI from ${needsAI.length} to ${MAX_AI_PER_BATCH}`);
      needsAI = needsAI.slice(0, MAX_AI_PER_BATCH);
    }

    if (needsAI.length > 0) {
      // Load reference data + shared prompt context
      const [accounts, categories, projects, companyRow] =
        await Promise.all([
          sql<AccountRow[]>`
            SELECT id, code, name, section
            FROM chart_of_accounts
            WHERE company_id = ${companyId} AND active = true AND is_header = false
            ORDER BY code
          `,
          sql<CategoryRow[]>`
            SELECT id, name, type
            FROM categories
            WHERE company_id = ${companyId} AND active = true
            ORDER BY name
          `,
          sql<ProjectRow[]>`
            SELECT id, code, name
            FROM projects
            WHERE company_id = ${companyId} AND status = 'active'
            ORDER BY code
          `,
          sql`
            SELECT name, vat_number
            FROM companies
            WHERE id = ${companyId}
            LIMIT 1
          `,
        ]);

      // Build shared system prompt
      const companyContext: CompanyContext | undefined = companyRow.length > 0
        ? {
            company_name: companyRow[0].name,
            sector: 'servizi',
            vat_number: companyRow[0].vat_number,
          }
        : undefined;

      const systemPrompt = getAccountingSystemPrompt(companyContext);
      const userInstructionsBlock = await getUserInstructionsBlock(sql, companyId);

      console.log(`[analyze] AI: classifying ${needsAI.length} txs with ${accounts.length} accounts, ${categories.length} categories`);

      const aiResults = await classifyWithAI(
        anthropicKey,
        needsAI,
        accounts,
        categories,
        projects,
        systemPrompt,
        userInstructionsBlock,
      );

      // Validate account_id and category_id exist
      const accountIds = new Set(accounts.map((a) => a.id));
      const accountByCode = new Map(accounts.map((a) => [a.code, a.id]));
      const categoryIds = new Set(categories.map((c) => c.id));
      const projectIds = new Set(projects.map((p) => p.id));

      aiRaw = aiResults.length;

      for (const r of aiResults) {
        if (r.account_id && !accountIds.has(r.account_id)) {
          // Fallback 1: AI returned a code instead of UUID
          const byCode = accountByCode.get(r.account_id);
          if (byCode) {
            r.account_id = byCode;
          } else {
            // Fallback 2: code in reasoning
            const codeMatch = r.reasoning?.match(/\b(\d{5,})\b/);
            if (codeMatch) {
              const byCode2 = accountByCode.get(codeMatch[1]);
              if (byCode2) r.account_id = byCode2;
              else r.account_id = null;
            } else {
              r.account_id = null;
            }
          }
        }
        if (r.category_id && !categoryIds.has(r.category_id)) {
          r.category_id = null;
        }
        if (r.cost_center_id && !projectIds.has(r.cost_center_id)) {
          r.cost_center_id = null;
        }

        if (r.account_id || r.category_id) {
          classificationResults.push(r);
          classifiedAI++;
        } else {
          aiSkipped++;
          console.log(`[analyze] Skipped tx ${r.transaction_id}: no valid account/category`);
        }
      }

      console.log(`[analyze] AI done: ${classifiedAI} classified, ${aiSkipped} skipped, ${aiRaw} raw`);
    }

    // ═══════════════════════════════════════
    // Save classification results
    // ═══════════════════════════════════════

    for (const r of classificationResults) {
      const isRule = r.reasoning?.startsWith("Regola appresa");
      await sql`
        UPDATE bank_transactions
        SET category_id = ${r.category_id},
            account_id = ${r.account_id},
            cost_center_id = ${r.cost_center_id},
            classification_status = 'ai_suggested',
            classification_source = ${isRule ? "rule" : "ai"},
            classification_confidence = ${r.confidence},
            classification_reasoning = ${r.reasoning},
            fiscal_flags = ${r.fiscal_flags ? JSON.stringify(r.fiscal_flags) : null}
        WHERE id = ${r.transaction_id}
          AND company_id = ${companyId}
      `;
    }

    const totalElapsed = Date.now() - startTime;
    console.log(`[analyze] Done in ${totalElapsed}ms: classified=${classificationResults.length}`);

    return json({
      classified: classificationResults.length,
      classified_rules: classifiedRules,
      classified_ai: classifiedAI,
      found: pendingTxs.length,
      ai_raw: aiRaw,
      ai_skipped: aiSkipped,
      elapsed_ms: totalElapsed,
      classification_details: classificationResults.map((r) => ({
        id: r.transaction_id,
        account_id: r.account_id,
        confidence: r.confidence,
      })),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Errore interno";
    console.error("[analyze] Error:", msg);
    return json({ error: msg }, 500);
  } finally {
    await sql.end();
  }
});
