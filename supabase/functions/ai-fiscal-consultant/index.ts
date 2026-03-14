// ai-fiscal-consultant — CFO/Consulente AI with Function Calling
// 11 tools: 7 shared with commercialista + 4 exclusive (bilancio, saldi, budget, storico decisioni)
// Invoked conditionally when commercialista flags needs_consultant=true.
// Also serves inline consultation from FatturePage.

import postgres from "npm:postgres@3.4.5";
import { callGeminiWithTools, callLLM, type ToolDeclaration } from "../_shared/llm-caller.ts";
import { callGeminiEmbedding, toVectorLiteral } from "../_shared/embeddings.ts";
import { loadKbAdvisoryContext } from "../_shared/kb-advisory.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ConsultingMode = "fast" | "deep" | "pipeline";

interface AgentConfig {
  system_prompt: string;
  model: string;
  model_escalation: string | null;
  temperature: number;
  thinking_level: string;
  thinking_budget: number | null;
  thinking_budget_escalation: number | null;
  max_output_tokens: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function clip(s: string | null | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function stripJsonBlock(text: string): string {
  return text.replace(/```json[\s\S]*?```/g, "").trim();
}

function parseResolutionAction(text: string): Record<string, unknown> | null {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    return parsed?.action && typeof parsed.action === "object" ? parsed.action : null;
  } catch {
    return null;
  }
}

/* ─── Tool Declarations (7 shared + 4 exclusive) ──────── */

const SHARED_TOOLS: ToolDeclaration[] = [
  {
    name: "cerca_conti",
    description: "Cerca nel piano dei conti per parole chiave e/o sezione.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "Parole chiave per cercare nel nome/codice" },
        section: { type: "STRING", description: "Filtra per sezione contabile" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_defaults_conto",
    description: "Legge i default fiscali di un conto specifico.",
    parameters: {
      type: "OBJECT",
      properties: {
        account_code: { type: "STRING", description: "Codice del conto" },
      },
      required: ["account_code"],
    },
  },
  {
    name: "storico_controparte",
    description: "Cerca classificazioni confermate per la controparte della fattura.",
    parameters: {
      type: "OBJECT",
      properties: {
        description_hint: { type: "STRING", description: "Parole chiave opzionali" },
      },
    },
  },
  {
    name: "get_tax_codes",
    description: "Cerca codici IVA disponibili.",
    parameters: {
      type: "OBJECT",
      properties: {
        aliquota: { type: "NUMBER" },
        tipo: { type: "STRING" },
        natura: { type: "STRING" },
      },
    },
  },
  {
    name: "get_parametro_fiscale",
    description: "Cerca parametri normativi fiscali.",
    parameters: {
      type: "OBJECT",
      properties: {
        codice: { type: "STRING" },
        categoria: { type: "STRING" },
        query: { type: "STRING" },
      },
    },
  },
  {
    name: "get_profilo_controparte",
    description: "Legge profilo fiscale della controparte.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "consulta_kb",
    description: "Cerca nella knowledge base note consultive e fonti normative.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "Domanda o argomento" },
      },
      required: ["query"],
    },
  },
];

const EXCLUSIVE_TOOLS: ToolDeclaration[] = [
  {
    name: "get_bilancio_pnl",
    description: "Legge il conto economico aggregato: ricavi, costi per sezione, EBITDA. Filtra per anno.",
    parameters: {
      type: "OBJECT",
      properties: {
        anno: { type: "NUMBER", description: "Anno fiscale (default: anno corrente)" },
      },
    },
  },
  {
    name: "get_saldi_conti",
    description: "Legge i saldi per conto o sezione. Opzionalmente filtra per mese/anno.",
    parameters: {
      type: "OBJECT",
      properties: {
        section: { type: "STRING", description: "Sezione contabile" },
        account_code: { type: "STRING", description: "Codice conto specifico" },
        anno: { type: "NUMBER" },
      },
    },
  },
  {
    name: "get_budget_fiscale",
    description: "Legge i budget fiscali (rappresentanza, veicoli, telefonia) e il consumo attuale.",
    parameters: {
      type: "OBJECT",
      properties: {
        anno: { type: "NUMBER" },
        budget_type: { type: "STRING", description: "Tipo: rappresentanza, veicoli, telefonia, vitto" },
      },
    },
  },
  {
    name: "get_storico_decisioni",
    description: "Cerca decisioni fiscali passate su alert simili (warning_flags, doubts).",
    parameters: {
      type: "OBJECT",
      properties: {
        warning_type: { type: "STRING", description: "Tipo di warning flag cercato" },
        description_hint: { type: "STRING", description: "Parole chiave nella descrizione riga" },
      },
    },
  },
];

const ALL_TOOLS = [...SHARED_TOOLS, ...EXCLUSIVE_TOOLS];

/* ─── Main ───────────────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    const dbUrl = Deno.env.get("SUPABASE_DB_URL");
    if (!dbUrl) return json({ error: "SUPABASE_DB_URL not set" }, 500);

    const body = await req.json();
    const {
      invoice_id,
      line_ids = [],
      alert_context = "",
      messages = [],
      company_id,
      consulting_mode = "deep",
      // Pipeline mode fields (from classificationPipelineService)
      commercialista_result = null,
      direction = null,
      counterparty_vat_key = null,
    } = body as {
      invoice_id: string;
      line_ids: string[];
      alert_context: string;
      messages: { role: "user" | "assistant"; content: string }[];
      company_id: string;
      consulting_mode?: ConsultingMode;
      commercialista_result?: any;
      direction?: string;
      counterparty_vat_key?: string;
    };

    if (!invoice_id || !company_id) {
      return json({ error: "invoice_id and company_id required" }, 400);
    }

    const sql = postgres(dbUrl, { max: 3 });

    try {
      const [agentRows, invoiceRows] = await Promise.all([
        sql<AgentConfig[]>`
          SELECT system_prompt, model, model_escalation, temperature, thinking_level,
                 thinking_budget, thinking_budget_escalation, max_output_tokens
          FROM agent_config
          WHERE active = true AND agent_type = 'consulente'
          LIMIT 1`,
        sql`
          SELECT i.id, i.number, i.date, i.direction, i.total_amount, i.taxable_amount,
                 i.tax_amount, i.withholding_amount, i.notes, i.doc_type,
                 c.name AS counterparty_name, c.fiscal_code, c.vat_number, c.vat_key,
                 c.tipo_soggetto, c.soggetto_a_ritenuta, c.cassa_previdenziale,
                 c.split_payment_soggetto, c.ateco_code AS cp_ateco, c.ateco_description AS cp_ateco_desc,
                 co.name AS company_name, co.vat_number AS company_vat, co.ateco_code,
                 co.ateco_description, co.fiscal_regime, co.iva_per_cassa
          FROM invoices i
          LEFT JOIN counterparties c ON i.counterparty_id = c.id
          LEFT JOIN companies co ON i.company_id = co.id
          WHERE i.id = ${invoice_id}
          LIMIT 1`,
      ]);

      const agentConfig = agentRows[0] || null;
      const invoice = invoiceRows[0];
      if (!invoice) return json({ error: "Invoice not found" }, 404);

      // Load line details if specified
      const lineRows = line_ids.length > 0
        ? await sql`
            SELECT il.id, il.description, il.total_price, il.vat_rate, il.category_id,
                   il.account_id, il.fiscal_flags, il.decision_status, il.reasoning_summary_final,
                   il.final_confidence, il.warning_flags, il.fiscal_reasoning_short,
                   cat.name AS category_name, acc.code AS account_code, acc.name AS account_name
            FROM invoice_lines il
            LEFT JOIN categories cat ON il.category_id = cat.id
            LEFT JOIN chart_of_accounts acc ON il.account_id = acc.id
            WHERE il.id = ANY(${line_ids})`
        : [];

      const companyAteco = invoice.ateco_code || "";
      const cpVatKey = counterparty_vat_key || invoice.vat_key || null;

      // ─── Build tool handler for CFO ──────
      async function toolHandler(name: string, args: Record<string, unknown>): Promise<unknown> {
        switch (name) {
          // Shared tools (same as commercialista)
          case "cerca_conti": {
            const query = String(args.query || "").trim();
            const section = args.section ? String(args.section) : null;
            const whereSection = section ? sql`AND section = ${section}` : sql``;
            return await sql`
              SELECT id, code, name, section, default_ires_pct, default_irap_mode, needs_user_confirmation
              FROM chart_of_accounts
              WHERE company_id = ${company_id} AND active = true AND is_header = false
                AND (name ILIKE ${'%' + query + '%'} OR code ILIKE ${'%' + query + '%'})
                ${whereSection}
              ORDER BY code LIMIT 15`;
          }

          case "get_defaults_conto": {
            const code = String(args.account_code || "");
            const [row] = await sql`
              SELECT coa.id, coa.code, coa.name, coa.section, coa.default_ires_pct,
                     coa.default_irap_mode, coa.needs_user_confirmation, coa.note_fiscali,
                     tc.codice AS tax_code, tc.descrizione AS tax_desc
              FROM chart_of_accounts coa
              LEFT JOIN tax_codes tc ON coa.default_tax_code_id = tc.id
              WHERE coa.company_id = ${company_id} AND coa.code = ${code} LIMIT 1`;
            return row || { error: `Conto ${code} non trovato` };
          }

          case "storico_controparte": {
            if (!cpVatKey) return { message: "No counterparty VAT key" };
            const vatKey = cpVatKey.toUpperCase().replace(/^IT/i, "").replace(/[^A-Z0-9]/gi, "");
            const dir = direction || invoice.direction || "in";
            return await sql`
              SELECT il.description, c.name AS category_name, a.code AS account_code, a.name AS account_name,
                     count(*)::int AS count
              FROM invoice_lines il
              JOIN invoices i ON il.invoice_id = i.id
              LEFT JOIN categories c ON il.category_id = c.id
              LEFT JOIN chart_of_accounts a ON il.account_id = a.id
              WHERE i.company_id = ${company_id} AND i.direction = ${dir}
                AND i.counterparty_id = (SELECT id FROM counterparties WHERE vat_key = ${vatKey} AND company_id = ${company_id} LIMIT 1)
                AND i.classification_status = 'confirmed' AND il.category_id IS NOT NULL
              GROUP BY il.description, c.name, a.code, a.name
              ORDER BY count DESC LIMIT 15`;
          }

          case "get_tax_codes": {
            const aliquota = args.aliquota != null ? Number(args.aliquota) : null;
            const natura = args.natura ? String(args.natura) : null;
            if (natura) {
              return await sql`SELECT codice, descrizione, aliquota, detraibilita_pct, normativa_ref
                FROM tax_codes WHERE (company_id IS NULL OR company_id = ${company_id}) AND is_active = true AND natura = ${natura}
                ORDER BY sort_order LIMIT 10`;
            }
            if (aliquota != null) {
              return await sql`SELECT codice, descrizione, aliquota, detraibilita_pct, normativa_ref
                FROM tax_codes WHERE (company_id IS NULL OR company_id = ${company_id}) AND is_active = true AND aliquota = ${aliquota}
                ORDER BY sort_order LIMIT 10`;
            }
            return await sql`SELECT codice, descrizione, aliquota, detraibilita_pct FROM tax_codes
              WHERE (company_id IS NULL OR company_id = ${company_id}) AND is_active = true ORDER BY sort_order LIMIT 20`;
          }

          case "get_parametro_fiscale": {
            const codice = args.codice ? String(args.codice) : null;
            const categoria = args.categoria ? String(args.categoria) : null;
            const invoiceDate = invoice.date || new Date().toISOString().slice(0, 10);
            if (codice) {
              const [row] = await sql`SELECT codice, nome, valore_numerico, valore_testo, unita, normativa_ref
                FROM fiscal_parameters WHERE codice = ${codice}
                AND valido_dal <= ${invoiceDate}::date AND (valido_al IS NULL OR valido_al >= ${invoiceDate}::date) LIMIT 1`;
              return row || { error: `Parametro ${codice} non trovato` };
            }
            if (categoria) {
              return await sql`SELECT codice, nome, valore_numerico, unita, normativa_ref FROM fiscal_parameters
                WHERE categoria = ${categoria} AND valido_dal <= ${invoiceDate}::date
                AND (valido_al IS NULL OR valido_al >= ${invoiceDate}::date) ORDER BY codice LIMIT 15`;
            }
            return { error: "Specifica codice o categoria" };
          }

          case "get_profilo_controparte": {
            return {
              name: invoice.counterparty_name,
              vat_number: invoice.vat_number,
              tipo_soggetto: invoice.tipo_soggetto,
              soggetto_a_ritenuta: invoice.soggetto_a_ritenuta || false,
              cassa_previdenziale: invoice.cassa_previdenziale || null,
              split_payment_soggetto: invoice.split_payment_soggetto || false,
              ateco_code: invoice.cp_ateco,
              ateco_description: invoice.cp_ateco_desc,
            };
          }

          case "consulta_kb": {
            const kbQuery = String(args.query || "");
            if (!geminiKey) return { error: "GEMINI_API_KEY not available for KB search" };
            try {
              const queryVec = await callGeminiEmbedding(geminiKey, kbQuery);
              const queryVecLiteral = toVectorLiteral(queryVec);
              const result = await loadKbAdvisoryContext(sql, {
                companyId: company_id,
                audience: "commercialista",
                queryVecLiteral,
                companyAteco,
                noteLimit: 3,
                chunkLimit: 3,
              });
              return {
                notes: result.notes.map((n) => ({ title: n.title, short_answer: n.short_answer, source_refs: n.source_refs })),
                chunks: result.chunks.map((c) => ({ doc_title: c.doc_title, section_title: c.section_title, content: c.content.slice(0, 500) })),
              };
            } catch (err: unknown) {
              return { error: `KB search failed: ${err instanceof Error ? err.message : String(err)}` };
            }
          }

          // ─── Exclusive CFO tools ──────
          case "get_bilancio_pnl": {
            const anno = args.anno ? Number(args.anno) : new Date().getFullYear();
            const startDate = `${anno}-01-01`;
            const endDate = `${anno}-12-31`;
            const rows = await sql`
              SELECT a.section,
                     SUM(CASE WHEN il.total_price > 0 THEN il.total_price ELSE 0 END)::numeric(15,2) AS totale_dare,
                     SUM(CASE WHEN il.total_price < 0 THEN ABS(il.total_price) ELSE 0 END)::numeric(15,2) AS totale_avere,
                     SUM(il.total_price)::numeric(15,2) AS saldo
              FROM invoice_lines il
              JOIN invoices i ON il.invoice_id = i.id
              LEFT JOIN chart_of_accounts a ON il.account_id = a.id
              WHERE i.company_id = ${company_id}
                AND i.date >= ${startDate}::date AND i.date <= ${endDate}::date
                AND il.account_id IS NOT NULL
              GROUP BY a.section
              ORDER BY a.section`;
            return { anno, sections: rows };
          }

          case "get_saldi_conti": {
            const section = args.section ? String(args.section) : null;
            const accountCode = args.account_code ? String(args.account_code) : null;
            if (accountCode) {
              const rows = await sql`
                SELECT a.code, a.name, SUM(il.total_price)::numeric(15,2) AS saldo
                FROM invoice_lines il
                JOIN invoices i ON il.invoice_id = i.id
                JOIN chart_of_accounts a ON il.account_id = a.id
                WHERE i.company_id = ${company_id} AND a.code = ${accountCode}
                GROUP BY a.code, a.name`;
              return rows;
            }
            if (section) {
              return await sql`
                SELECT a.code, a.name, SUM(il.total_price)::numeric(15,2) AS saldo
                FROM invoice_lines il
                JOIN invoices i ON il.invoice_id = i.id
                JOIN chart_of_accounts a ON il.account_id = a.id
                WHERE i.company_id = ${company_id} AND a.section = ${section}
                GROUP BY a.code, a.name
                ORDER BY a.code LIMIT 30`;
            }
            return { error: "Specifica section o account_code" };
          }

          case "get_budget_fiscale": {
            const anno = args.anno ? Number(args.anno) : new Date().getFullYear();
            const budgetType = args.budget_type ? String(args.budget_type) : null;
            if (budgetType) {
              return await sql`
                SELECT budget_type, budget_limit, consumed, remaining, anno
                FROM fiscal_budgets
                WHERE company_id = ${company_id} AND anno = ${anno} AND budget_type = ${budgetType}
                LIMIT 1`;
            }
            return await sql`
              SELECT budget_type, budget_limit, consumed, remaining
              FROM fiscal_budgets
              WHERE company_id = ${company_id} AND anno = ${anno}
              ORDER BY budget_type`;
          }

          case "get_storico_decisioni": {
            const warningType = args.warning_type ? String(args.warning_type) : null;
            const descHint = args.description_hint ? String(args.description_hint) : null;
            if (warningType) {
              return await sql`
                SELECT il.description, il.warning_flags, il.fiscal_reasoning_short, il.user_answer_summary,
                       il.classification_status, a.code AS account_code, a.name AS account_name
                FROM invoice_lines il
                LEFT JOIN chart_of_accounts a ON il.account_id = a.id
                WHERE il.invoice_id IN (SELECT id FROM invoices WHERE company_id = ${company_id})
                  AND il.classification_status = 'confirmed'
                  AND ${warningType} = ANY(il.warning_flags)
                ORDER BY il.updated_at DESC LIMIT 10`;
            }
            if (descHint) {
              return await sql`
                SELECT il.description, il.warning_flags, il.fiscal_reasoning_short, il.user_answer_summary,
                       il.classification_status, a.code AS account_code
                FROM invoice_lines il
                LEFT JOIN chart_of_accounts a ON il.account_id = a.id
                WHERE il.invoice_id IN (SELECT id FROM invoices WHERE company_id = ${company_id})
                  AND il.classification_status = 'confirmed'
                  AND il.description ILIKE ${'%' + descHint + '%'}
                ORDER BY il.updated_at DESC LIMIT 10`;
            }
            return { error: "Specifica warning_type o description_hint" };
          }

          default:
            return { error: `Tool sconosciuto: ${name}` };
        }
      }

      const mode: ConsultingMode = consulting_mode === "pipeline" ? "pipeline" : consulting_mode === "fast" ? "fast" : "deep";
      // callGeminiWithTools only works with Gemini — force fallback for non-Gemini models
      const rawModel = mode === "deep" || mode === "pipeline"
        ? (agentConfig?.model_escalation || agentConfig?.model || "gemini-2.5-pro")
        : (agentConfig?.model || "gemini-2.5-pro");
      const model = rawModel.startsWith("gemini-") ? rawModel : "gemini-2.5-pro";
      const temperature = agentConfig?.temperature ?? 0.1;
      const maxOutputTokens = agentConfig?.max_output_tokens || 8192;

      const systemPrompt = agentConfig?.system_prompt
        || "Sei un consulente fiscale e contabile italiano senior. Offri consulenza prudente, contestuale e applicabile.";

      // ─── Pipeline mode: use function calling ──────
      if (mode === "pipeline" && commercialista_result) {
        const lineContext = (lineRows as any[]).map((row) =>
          `- [${row.id}] "${clip(row.description, 200)}" | tot=${row.total_price} | IVA=${row.vat_rate || "N/A"}% | conto=${row.account_code || "N/A"} | conf=${row.final_confidence || "N/A"} | warnings=${JSON.stringify(row.warning_flags || [])}`
        ).join("\n");

        const pipelinePrompt = `SEI IL CONSULENTE CFO. Il commercialista ha classificato questa fattura e ha segnalato dubbi.

FATTURA: ${invoice.number || "N/D"} del ${invoice.date || "N/D"} | ${invoice.direction === "in" ? "PASSIVA" : "ATTIVA"} | €${invoice.total_amount}
CONTROPARTE: ${invoice.counterparty_name || "N/D"}
AZIENDA: ${invoice.company_name || "N/D"} (ATECO: ${invoice.ateco_code || "N/D"})

MOTIVAZIONE ESCALATION:
${commercialista_result.consultant_reason || "Non specificata"}

RIGHE CON DUBBI:
${lineContext || "(nessuna riga caricata)"}

PROPOSTE COMMERCIALISTA:
${JSON.stringify(commercialista_result.lines?.filter((l: any) => l.doubts?.length > 0).slice(0, 10) || [], null, 2)}

ISTRUZIONI:
1. USA I TOOL per approfondire (KB, parametri, storico, bilancio)
2. Rispondi con un JSON:
{
  "review_summary": "...",
  "line_overrides": [{"line_id": "uuid", "field": "...", "old_value": ..., "new_value": ..., "reasoning": "..."}],
  "recommendations": ["..."],
  "risk_level": "low|medium|high"
}`;

        if (geminiKey) {
          const llmResp = await callGeminiWithTools(
            systemPrompt,
            pipelinePrompt,
            ALL_TOOLS,
            toolHandler,
            { model, temperature, maxOutputTokens },
            geminiKey,
            8,
          );

          return json({
            message: stripJsonBlock(llmResp.text),
            action: llmResp.structured || null,
            thinking: llmResp.thinking || null,
            consultant_mode: mode,
            model_used: model,
            tool_calls: llmResp.tool_calls_log,
          });
        }
      }

      // ─── Interactive mode (fast/deep): existing behavior with optional function calling ──────
      const lineContext = (lineRows as any[]).map((row) =>
        `- [${row.id}] "${clip(row.description, 220)}" | tot=${row.total_price} | IVA=${row.vat_rate || "N/A"}% | cat=${row.category_name || "N/A"} | conto=${row.account_code || "N/A"} ${row.account_name || ""} | stato=${row.decision_status || "pending"} | conf=${row.final_confidence || "N/A"} | fiscal=${JSON.stringify(row.fiscal_flags || {})}`
      ).join("\n");

      const historyContext = messages
        .slice(-8)
        .map((message) => `${message.role === "user" ? "Utente" : "Consulente"}: ${message.content}`)
        .join("\n");

      const prompt = `CONTESTO AZIENDA:
- Azienda: ${invoice.company_name || "N/A"} (P.IVA: ${invoice.company_vat || "N/A"})
- ATECO: ${invoice.ateco_code || "N/A"} ${invoice.ateco_description || ""}
- Regime: ${invoice.fiscal_regime || "N/A"} | IVA per cassa: ${invoice.iva_per_cassa ? "SI" : "NO"}

CONTESTO FATTURA:
- Numero: ${invoice.number || "N/A"} del ${invoice.date || "N/A"}
- Direzione: ${invoice.direction === "in" ? "Passiva (acquisto)" : "Attiva (vendita)"}
- Importo: €${invoice.total_amount || "N/A"} | Imponibile: €${invoice.taxable_amount || "N/A"} | IVA: €${invoice.tax_amount || "N/A"}
- Controparte: ${invoice.counterparty_name || "N/A"} (P.IVA: ${invoice.vat_number || "N/A"})

RIGHE COINVOLTE:
${lineContext || "(nessuna riga specifica)"}

ALERT / DUBBIO ATTIVO:
${alert_context || "(nessun alert specifico)"}

STORICO CHAT:
${historyContext || "(nessun messaggio precedente)"}

ISTRUZIONI:
1. Rispondi in italiano, chiaro e professionale.
2. USA I TOOL per verificare parametri, conti, KB se necessario.
3. Se proponi una risoluzione, includi un blocco JSON opzionale con questa struttura:
\`\`\`json
{"action":{"type":"apply_consultant_resolution","recommended_conclusion":"...","rationale_summary":"...","risk_level":"low|medium|high","line_updates":[{"line_id":"uuid","category_id":"uuid|null","account_id":"uuid|null","fiscal_flags":{},"decision_status":"finalized|needs_review","reasoning_summary_final":"...","final_confidence":72}]}}
\`\`\``;

      // Use function calling for deep mode with Gemini
      if (mode === "deep" && geminiKey && model.startsWith("gemini-")) {
        const llmResp = await callGeminiWithTools(
          systemPrompt,
          prompt,
          ALL_TOOLS,
          toolHandler,
          { model, temperature, maxOutputTokens },
          geminiKey,
          8,
        );

        const action = parseResolutionAction(llmResp.text);
        const message = stripJsonBlock(llmResp.text);

        return json({
          message,
          action,
          thinking: llmResp.thinking || null,
          consultant_mode: mode,
          model_used: model,
          tool_calls: llmResp.tool_calls_log,
        });
      }

      // Fallback: plain LLM call (fast mode or non-Gemini models)
      const thinkingBudget = mode === "deep"
        ? (agentConfig?.thinking_budget_escalation ?? agentConfig?.thinking_budget ?? 24576)
        : (agentConfig?.thinking_budget ?? 4096);

      const llmResp = await callLLM(prompt, {
        model,
        temperature,
        thinkingBudget: mode === "deep" ? thinkingBudget : 0,
        maxOutputTokens,
        systemPrompt
      }, { geminiKey, anthropicKey, openaiKey });

      const action = parseResolutionAction(llmResp.text);
      const message = stripJsonBlock(llmResp.text);

      return json({
        message,
        action,
        thinking: llmResp.thinking || null,
        consultant_mode: mode,
        model_used: model,
      });
    } finally {
      await sql.end();
    }
  } catch (err: any) {
    console.error("[ai-fiscal-consultant] Error:", err);
    return json(
      { error: err.message || "Internal error", message: "Mi dispiace, si è verificato un errore. Riprova." },
      500,
    );
  }
});
