// analyze-bank-transactions — Two-phase AI analysis of unreconciled bank transactions
// Phase 1: TRIAGE — classify as invoice_payment | no_invoice | giro_conto
// Phase 2: CLASSIFICATION — assign accounting codes to no_invoice movements
//
// PRINCIPLE: produces SUGGESTIONS only (classification_status = 'ai_suggested').
// NEVER 'confirmed'. User must always confirm.
// tx_nature is a SOFT label — does NOT exclude from reconciliation.

import postgres from "npm:postgres@3.4.5";

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
  tx_nature: string | null;
}

interface TriageResult {
  transaction_id: string;
  tx_nature: "invoice_payment" | "no_invoice" | "giro_conto";
  confidence: number;
  reasoning: string;
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

/* ─── Phase 1: Deterministic triage ────── */

function triageDeterministic(
  tx: TxRow,
): "invoice_payment" | "no_invoice" | "giro_conto" | null {
  const desc =
    ((tx.description || "") + " " + (tx.raw_text || "")).toUpperCase();
  const type = (tx.transaction_type || "").toLowerCase();

  // Giroconto
  if (
    desc.includes("GIROCONTO") ||
    desc.includes("GIRO FONDI") ||
    type === "giroconto"
  )
    return "giro_conto";

  // Pagamenti: disposizioni, bonifici (PRIMA delle commissioni!)
  // "Disposizione di pagamento con commissioni" è un PAGAMENTO, non una commissione
  if (
    desc.includes("DISPOSIZIONE DI PAGAMENTO") ||
    desc.includes("VOSTRA DISPOSIZIONE A FAVORE") ||
    desc.includes("BONIFICO A FAVORE") ||
    desc.includes("BONIFICO DISPOSTO") ||
    desc.includes("VS.DISPOSIZIONE A FAVORE") ||
    desc.includes("VS DISPOSIZIONE A FAVORE")
  )
    return "invoice_payment";

  // Commissioni, spese, interessi bancari (solo se NON è un pagamento — check sopra)
  if (
    desc.includes("COMMISSIONI") ||
    desc.includes("SPESE TENUTA") ||
    desc.includes("CANONE MENSILE") ||
    desc.includes("IMPOSTA BOLLO") ||
    desc.includes("INTERESSI CREDITORE") ||
    desc.includes("INTERESSI DEBITORE") ||
    (desc.includes("COMPETENZE") && desc.includes("LIQUIDAZIONE")) ||
    type === "commissione" ||
    type === "interesse"
  )
    return "no_invoice";

  // F24 / tributi
  if (
    desc.includes("F24") ||
    desc.includes("DELEGA UNICA") ||
    desc.includes("VERSAMENTO IMPOSTE") ||
    desc.includes("PAGAMENTO TRIBUTI")
  )
    return "no_invoice";

  // Stipendi
  if (
    desc.includes("STIPENDI") ||
    desc.includes("EMOLUMENTI") ||
    desc.includes("PAGHE") ||
    desc.includes("NETTIZZAZIONE")
  )
    return "no_invoice";

  // Prelievo/versamento cassa
  if (desc.includes("PRELIEVO CASSA") || desc.includes("VERSAMENTO CONTANTI"))
    return "giro_conto";

  return null; // uncertain → pass to AI
}

/* ─── Phase 1: AI triage ───────────────── */

async function triageWithAI(
  anthropicKey: string,
  transactions: TxRow[],
  openCounterparties: { name: string; open_amount: number }[],
): Promise<TriageResult[]> {
  const cpList = openCounterparties
    .map((cp) => `- ${cp.name}: €${Math.abs(cp.open_amount).toFixed(2)} aperte`)
    .join("\n");

  const txList = transactions
    .map(
      (tx) =>
        `- ID: ${tx.id} | Data: ${tx.date} | Importo: €${tx.amount} | Desc: ${(tx.description || "").slice(0, 120)} | Controparte: ${tx.counterparty_name || "N/D"} | Tipo: ${tx.transaction_type || "N/D"} | Raw: ${(tx.raw_text || "").slice(0, 200)}`,
    )
    .join("\n");

  const prompt = `Sei un contabile italiano. Per ogni movimento bancario, determina se è:
- "invoice_payment": un pagamento/incasso legato a una fattura (bonifico a fornitore, incasso da cliente, addebito SDD per fattura, RIBA)
- "no_invoice": un movimento che NON ha una fattura associata (commissioni, interessi, F24, stipendi, canoni bancari, imposte)
- "giro_conto": un trasferimento tra conti della stessa azienda

FORNITORI/CLIENTI DELL'AZIENDA (con fatture aperte):
${cpList || "(nessuna fattura aperta)"}

MOVIMENTI DA CLASSIFICARE:
${txList}

Indizi per il triage:
- Se la controparte del movimento corrisponde (anche parzialmente) a un fornitore/cliente con fatture aperte → invoice_payment
- Se l'importo è simile (±15%) a una fattura aperta di quella controparte → invoice_payment con alta confidence
- Bonifici in uscita con nome fornitore → quasi sempre invoice_payment
- SDD/RIBA → quasi sempre invoice_payment
- "COMMISSIONI", "SPESE", "INTERESSI", "BOLLO", "CANONE" → no_invoice
- "F24", "DELEGA", "INPS", "IRPEF" → no_invoice
- "GIROCONTO", "TRASFERIMENTO", "TRA NOSTRI CONTI" → giro_conto

Rispondi SOLO JSON array:
[{"transaction_id": "uuid", "tx_nature": "invoice_payment|no_invoice|giro_conto", "confidence": 0-100, "reasoning": "breve spiegazione"}]`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic triage ${resp.status}: ${errText.slice(0, 300)}`);
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
    console.error("[analyze] No JSON array in triage response:", cleaned.slice(0, 300));
    return [];
  }
  return JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
}

/* ─── Phase 2: Classification rules fast-path ── */

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
      // Check direction match
      if (rule.direction && rule.direction !== tx.direction) continue;
      // Check pattern match (longest wins)
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

/* ─── Phase 2: AI classification ────────── */

async function classifyWithAI(
  anthropicKey: string,
  transactions: TxRow[],
  accounts: AccountRow[],
  categories: CategoryRow[],
  projects: ProjectRow[],
  userInstructions: string[],
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

  const userRulesSection = userInstructions.length > 0
    ? `\n\nREGOLE UTENTE (priorità alta):\n${userInstructions.map((r) => `- ${r}`).join("\n")}`
    : "";

  const prompt = `Sei un contabile italiano esperto. Classifica questi movimenti bancari che NON hanno una fattura associata.

PIANO DEI CONTI (conti costo/ricavo):
${accountList}

PIANO DEI CONTI COMPLETO (per pagamenti F24 = debiti tributari/previdenziali):
${fullAccountList}

CATEGORIE:
${catList || "(nessuna categoria)"}

CENTRI DI COSTO:
${cdcList || "(nessun centro di costo)"}

CLASSIFICAZIONI COMUNI PER MOVIMENTI SENZA FATTURA:
- Commissioni bancarie, spese c/c, spese incasso → 64330 Spese di banca
- Spese incasso RIBA/SDD → 64333 Spese incasso Italia/estero
- Interessi passivi → 64000 Interessi passivi
- Interessi attivi → 72031 Altri proventi
- Imposta di bollo c/c → 63203 Imposta di bollo
- F24 IRES acconto/saldo → 42056 Erario c/acconto IRES (riduzione credito, NON costo)
- F24 IRAP → 42058 Erario c/acconto IRAP
- F24 ritenute dipendenti → 45000 Ritenute fiscali lavoro dipendente
- F24 ritenute lavoro autonomo → 45003 Ritenute fiscali lavoro autonomo
- F24 INPS → 45200 INPS
- F24 INAIL → 4521001 INAIL
- F24 addizionali regionali → 45010 Addizionale Regionale
- F24 addizionali comunali → 45011 Addizionale Comunale
- Stipendi netti → 45420 Personale-retribuzioni dovute
- Canoni carte di credito → 64330 Spese di banca
- Bollo auto → 63207 Tassa possesso automezzi 100%

IMPORTANTE:
- I pagamenti F24 NON sono costi — sono versamenti di debiti tributari/previdenziali (conti 4xxxx)
- I giroconto → escludi (non classificare)
- Le commissioni sono SEMPRE costi finanziari (64xxx)
${userRulesSection}

MOVIMENTI DA CLASSIFICARE:
${txList}

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
    force?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body JSON non valido" }, 400);
  }

  const companyId = body.company_id;
  if (!companyId) return json({ error: "company_id richiesto" }, 400);

  const batchSize = Math.min(body.batch_size || 20, 20); // cap server-side to avoid 504 timeout
  const force = body.force || false;
  const MAX_PHASE2_AI = 10; // max transactions for AI classification per batch
  const WALL_CLOCK_LIMIT_MS = 80_000; // 80s — leave 70s buffer for Phase 2
  const startTime = Date.now();

  const sql = postgres(dbUrl, { max: 1 });

  try {
    // ═══════════════════════════════════════
    // PHASE 1: TRIAGE
    // ═══════════════════════════════════════

    // 1a. Select unmatched transactions without triage
    const targets: TxRow[] = await sql`
      SELECT id, date, amount, description, counterparty_name,
             transaction_type, raw_text, direction, commission_amount,
             category_code, reconciliation_status, tx_nature
      FROM bank_transactions
      WHERE company_id = ${companyId}
        AND reconciliation_status IN ('unmatched', 'partial')
        ${force ? sql`AND TRUE` : sql`AND tx_nature IS NULL`}
      ORDER BY date DESC
      LIMIT ${batchSize}
    `;

    console.log(`[analyze] Phase 1: ${targets.length} untriaged targets found`);

    // NOTE: Do NOT early-return here when targets.length === 0.
    // Phase 2 runs independently on already-triaged no_invoice transactions.

    // 1b. Deterministic triage first
    const triageResults: TriageResult[] = [];
    let triagedDeterministic = 0;
    let triagedAI = 0;

    if (targets.length > 0) {
      const needsAI: TxRow[] = [];

      for (const tx of targets) {
        const nature = triageDeterministic(tx);
        if (nature) {
          triageResults.push({
            transaction_id: tx.id,
            tx_nature: nature,
            confidence: 95,
            reasoning: "Triage deterministico basato su parole chiave",
          });
          triagedDeterministic++;
        } else {
          needsAI.push(tx);
        }
      }

      // 1c. AI triage for uncertain transactions
      if (needsAI.length > 0) {
        // Get counterparties with open invoices for context
        const openCounterparties: { name: string; open_amount: number }[] =
          await sql`
          SELECT DISTINCT c.name,
            COALESCE(SUM(ii.amount_due - ii.paid_amount), 0) as open_amount
          FROM counterparties c
          JOIN invoices i ON i.counterparty_id = c.id
          JOIN invoice_installments ii ON ii.invoice_id = i.id
          WHERE c.company_id = ${companyId}
            AND ii.status IN ('pending', 'partial')
          GROUP BY c.id, c.name
          HAVING COALESCE(SUM(ii.amount_due - ii.paid_amount), 0) > 0.01
          ORDER BY open_amount DESC
          LIMIT 100
        `;

        const aiTriageResults = await triageWithAI(
          anthropicKey,
          needsAI,
          openCounterparties,
        );
        for (const r of aiTriageResults) {
          if (
            r.tx_nature === "invoice_payment" ||
            r.tx_nature === "no_invoice" ||
            r.tx_nature === "giro_conto"
          ) {
            triageResults.push(r);
            triagedAI++;
          }
        }
      }

      // 1d. Save triage results
      for (const r of triageResults) {
        await sql`
          UPDATE bank_transactions
          SET tx_nature = ${r.tx_nature}
          WHERE id = ${r.transaction_id}
            AND company_id = ${companyId}
        `;
      }

      console.log(`[analyze] Phase 1 done: ${triagedDeterministic} deterministic, ${triagedAI} AI (total ${triageResults.length})`);
    }

    // ═══════════════════════════════════════
    // PHASE 2: CLASSIFICATION (no_invoice only)
    // ═══════════════════════════════════════

    const classificationResults: ClassifyResult[] = [];
    let classifiedRules = 0;
    let classifiedAI = 0;
    let phase2Skipped = false;
    let phase2Found = 0;
    let phase2AIRaw = 0;
    let phase2AISkipped = 0;

    // Time guard: skip Phase 2 if we've already spent too long on Phase 1
    const elapsedMs = Date.now() - startTime;
    if (elapsedMs > WALL_CLOCK_LIMIT_MS) {
      console.log(`[analyze] Phase 1 took ${elapsedMs}ms, skipping Phase 2 to avoid timeout`);
      phase2Skipped = true;
    }

    if (!phase2Skipped) {
      // 2a. Select no_invoice transactions pending classification
      const noInvoiceTxs: TxRow[] = await sql`
        SELECT id, date, amount, description, counterparty_name,
               transaction_type, raw_text, direction, commission_amount,
               category_code, reconciliation_status, tx_nature
        FROM bank_transactions
        WHERE company_id = ${companyId}
          AND tx_nature = 'no_invoice'
          AND classification_status = 'pending'
        ORDER BY date DESC
        LIMIT ${batchSize}
      `;

      phase2Found = noInvoiceTxs.length;
      console.log(`[analyze] Phase 2: ${noInvoiceTxs.length} no_invoice pending found (limit ${batchSize})`);

      if (noInvoiceTxs.length > 0) {
        // 2b. Fast-path: classification rules
        const ruleMatches = await findMatchingRulesForTx(
          sql,
          companyId,
          noInvoiceTxs,
        );
        let needsAIClassification: TxRow[] = [];

        for (const tx of noInvoiceTxs) {
          const ruleResult = ruleMatches.get(tx.id);
          if (ruleResult) {
            classificationResults.push(ruleResult);
            classifiedRules++;
          } else {
            needsAIClassification.push(tx);
          }
        }

        console.log(`[analyze] Phase 2: ${classifiedRules} rule matches, ${needsAIClassification.length} need AI`);

        // 2c. AI classification for remaining (capped to avoid timeout)
        if (needsAIClassification.length > MAX_PHASE2_AI) {
          console.log(`[analyze] Capping AI classification from ${needsAIClassification.length} to ${MAX_PHASE2_AI}`);
          needsAIClassification = needsAIClassification.slice(0, MAX_PHASE2_AI);
        }
        if (needsAIClassification.length > 0) {
          // Load reference data
          const [accounts, categories, projects, userInstructionRows] =
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
              sql<{ instruction: string }[]>`
                SELECT instruction
                FROM user_instructions
                WHERE company_id = ${companyId}
                  AND active = true
                  AND scope IN ('general', 'classification')
                ORDER BY created_at
              `,
            ]);

          const userInstructions = userInstructionRows.map((r) => r.instruction);

          console.log(`[analyze] Phase 2 AI: classifying ${needsAIClassification.length} txs with ${accounts.length} accounts, ${categories.length} categories`);

          const aiResults = await classifyWithAI(
            anthropicKey,
            needsAIClassification,
            accounts,
            categories,
            projects,
            userInstructions,
          );

          // Validate account_id and category_id exist
          const accountIds = new Set(accounts.map((a) => a.id));
          const accountByCode = new Map(accounts.map((a) => [a.code, a.id]));
          const categoryIds = new Set(categories.map((c) => c.id));
          const projectIds = new Set(projects.map((p) => p.id));

          phase2AIRaw = aiResults.length;

          for (const r of aiResults) {
            // Validate IDs before saving
            if (r.account_id && !accountIds.has(r.account_id)) {
              // Fallback 1: AI returned a code instead of UUID
              const byCode = accountByCode.get(r.account_id);
              if (byCode) {
                console.log(`[analyze] account_id fallback: code ${r.account_id} → ${byCode}`);
                r.account_id = byCode;
              } else {
                // Fallback 2: Try to match by code in the reasoning
                const codeMatch = r.reasoning?.match(/\b(\d{5,})\b/);
                if (codeMatch) {
                  const byCode2 = accountByCode.get(codeMatch[1]);
                  if (byCode2) {
                    console.log(`[analyze] account_id fallback from reasoning: ${codeMatch[1]} → ${byCode2}`);
                    r.account_id = byCode2;
                  } else {
                    console.log(`[analyze] account_id rejected: ${r.account_id}, code ${codeMatch?.[1]} not found`);
                    r.account_id = null;
                  }
                } else {
                  console.log(`[analyze] account_id rejected: ${r.account_id} (not valid UUID, no code in reasoning)`);
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
              phase2AISkipped++;
              console.log(`[analyze] Skipped tx ${r.transaction_id}: account_id=${r.account_id}, category_id=${r.category_id}, reasoning=${r.reasoning?.slice(0, 80)}`);
            }
          }

          console.log(`[analyze] Phase 2 AI done: ${classifiedAI} classified, ${phase2AISkipped} skipped (no valid account/category), ${phase2AIRaw} raw AI results`);
        }

        // 2d. Save classification results
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
      }
    } // end if (!phase2Skipped)

    const totalElapsed = Date.now() - startTime;
    console.log(`[analyze] Done in ${totalElapsed}ms: triaged=${triageResults.length} classified=${classificationResults.length} phase2Skipped=${phase2Skipped}`);

    return json({
      triaged: triageResults.length,
      triaged_deterministic: triagedDeterministic,
      triaged_ai: triagedAI,
      classified: classificationResults.length,
      classified_rules: classifiedRules,
      classified_ai: classifiedAI,
      phase2_skipped: phase2Skipped,
      phase2_found: phase2Found,
      phase2_ai_raw: phase2AIRaw,
      phase2_ai_skipped: phase2AISkipped,
      elapsed_ms: totalElapsed,
      triage_details: triageResults.map((r) => ({
        id: r.transaction_id,
        tx_nature: r.tx_nature,
        confidence: r.confidence,
      })),
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
