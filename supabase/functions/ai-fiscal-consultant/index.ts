import postgres from "npm:postgres@3.4.5";
import { callLLM } from "../_shared/llm-caller.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EMBEDDING_MODEL = "gemini-embedding-001";
const EXPECTED_DIMS = 3072;

type ConsultingMode = "fast" | "deep";

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

function toVectorLiteral(values: number[]): string {
  return `[${values.map((v) => (Number.isFinite(v) ? v.toFixed(8) : "0")).join(",")}]`;
}

async function callGeminiEmbedding(apiKey: string, text: string): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      taskType: "RETRIEVAL_QUERY",
      outputDimensionality: EXPECTED_DIMS,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Gemini embedding error: ${payload?.error?.message || response.status}`);
  }
  const values = payload?.embedding?.values;
  if (!Array.isArray(values) || values.length !== EXPECTED_DIMS) {
    throw new Error("Bad embedding dims");
  }
  return values.map((value: unknown) => Number(value));
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

// Extracted individual model callers to _shared/llm-caller.ts

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

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
    } = body as {
      invoice_id: string;
      line_ids: string[];
      alert_context: string;
      messages: { role: "user" | "assistant"; content: string }[];
      company_id: string;
      consulting_mode?: ConsultingMode;
    };

    if (!invoice_id || !company_id) {
      return json({ error: "invoice_id and company_id required" }, 400);
    }

    const sql = postgres(dbUrl, { max: 2 });

    try {
      const [agentRows, invoiceRows, companyStatsRows] = await Promise.all([
        sql<AgentConfig[]>`
          SELECT system_prompt, model, model_escalation, temperature, thinking_level,
                 thinking_budget, thinking_budget_escalation, max_output_tokens
          FROM agent_config
          WHERE active = true AND agent_type = 'consulente'
          LIMIT 1`,
        sql`
          SELECT i.id, i.number, i.date, i.direction, i.total_amount, i.notes,
                 c.name AS counterparty_name, c.fiscal_code, c.vat_number,
                 co.name AS company_name, co.vat_number AS company_vat, co.ateco_code,
                 co.business_sector, co.legal_form, co.iva_periodicity
          FROM invoices i
          LEFT JOIN counterparties c ON i.counterparty_id = c.id
          LEFT JOIN companies co ON i.company_id = co.id
          WHERE i.id = ${invoice_id}
          LIMIT 1`,
        sql`
          SELECT
            (SELECT count(*) FROM invoices WHERE company_id = ${company_id})::int AS invoices_count,
            (SELECT count(*) FROM bank_transactions WHERE company_id = ${company_id})::int AS bank_tx_count,
            (SELECT coalesce(sum(amount_due - paid_amount), 0) FROM invoice_installments WHERE company_id = ${company_id} AND direction = 'in' AND status IN ('pending', 'overdue', 'partial')) AS total_to_pay,
            (SELECT coalesce(sum(amount_due - paid_amount), 0) FROM invoice_installments WHERE company_id = ${company_id} AND direction = 'out' AND status IN ('pending', 'overdue', 'partial')) AS total_to_collect,
            (SELECT coalesce(sum(amount_due - paid_amount), 0) FROM invoice_installments WHERE company_id = ${company_id} AND status = 'overdue') AS overdue_total,
            (SELECT coalesce(sum(total_amount), 0) FROM invoices WHERE company_id = ${company_id} AND date >= date_trunc('year', current_date)) AS invoices_ytd,
            (SELECT coalesce(sum(amount), 0) FROM bank_transactions WHERE company_id = ${company_id}) AS bank_balance`,
      ]);

      const agentConfig = agentRows[0] || null;
      const invoice = invoiceRows[0];
      if (!invoice) return json({ error: "Invoice not found" }, 404);
      const companyStats = companyStatsRows[0] || {};

      const lineRows = line_ids.length > 0
        ? await sql`
            SELECT
              il.id,
              il.description,
              il.total_price,
              il.vat_rate,
              il.category_id,
              il.account_id,
              il.fiscal_flags,
              il.decision_status,
              il.reasoning_summary_final,
              il.final_confidence,
              il.final_decision_source,
              il.line_note,
              cat.name AS category_name,
              acc.code AS account_code,
              acc.name AS account_name
            FROM invoice_lines il
            LEFT JOIN categories cat ON il.category_id = cat.id
            LEFT JOIN chart_of_accounts acc ON il.account_id = acc.id
            WHERE il.id = ANY(${line_ids})
          `
        : [];

      const chartRows = await sql`
        SELECT code, name, section
        FROM chart_of_accounts
        WHERE company_id = ${company_id} AND parent_id IS NOT NULL
        ORDER BY code
        LIMIT 200
      `;

      let kbContext = "";
      if (geminiKey) {
        try {
          const ragQuery = `${alert_context} ${invoice.counterparty_name || ""} ${lineRows.map((row: any) => row.description).join(" | ")}`;
          const ragVec = await callGeminiEmbedding(geminiKey, clip(ragQuery, 2000));
          const vecLit = toVectorLiteral(ragVec);
          const docChunks = await sql.unsafe(
            `SELECT kc.content, kc.section_title, kd.title AS doc_title,
                    (1 - (kc.embedding <=> $1::halfvec(3072)))::float AS similarity
             FROM kb_chunks kc
             JOIN kb_documents kd ON kc.document_id = kd.id
             WHERE (kc.company_id IS NULL OR kc.company_id = $2)
               AND kd.status = 'ready'
             ORDER BY kc.embedding <=> $1::halfvec(3072)
             LIMIT 5`,
            [vecLit, company_id],
          );
          const relevant = (docChunks as any[]).filter((chunk) => chunk.similarity >= 0.4);
          if (relevant.length > 0) {
            kbContext = relevant.map((chunk: any) => {
              const header = chunk.section_title || chunk.doc_title || "Documento";
              return `[${header}] ${clip(chunk.content, 900)}`;
            }).join("\n\n");
          }
        } catch (error) {
          console.warn("[ai-fiscal-consultant] RAG failed:", error);
        }
      }

      const lineContext = (lineRows as any[]).map((row) =>
        `- [${row.id}] "${clip(row.description, 220)}" | tot=${row.total_price} | IVA=${row.vat_rate || "N/A"}% | cat=${row.category_name || "N/A"} | conto=${row.account_code || "N/A"} ${row.account_name || ""} | stato=${row.decision_status || "pending"} | fonte=${row.final_decision_source || "N/A"} | conf=${row.final_confidence || "N/A"} | reasoning_final=${clip(row.reasoning_summary_final, 220)} | note=${clip(row.line_note, 180)} | fiscal=${JSON.stringify(row.fiscal_flags || {})}`
      ).join("\n");

      const chartContext = (chartRows as any[])
        .map((row) => `${row.code} ${row.name} (${row.section})`)
        .join("\n");

      const historyContext = messages
        .slice(-8)
        .map((message) => `${message.role === "user" ? "Utente" : "Consulente"}: ${message.content}`)
        .join("\n");

      const systemPrompt = agentConfig?.system_prompt
        || "Sei un consulente fiscale e contabile italiano senior. Offri consulenza prudente, contestuale e applicabile.";

      const prompt = `CONTESTO AZIENDA:
- Azienda: ${invoice.company_name || "N/A"} (P.IVA: ${invoice.company_vat || "N/A"})
- ATECO: ${invoice.ateco_code || "N/A"}
- Settore: ${invoice.business_sector || "N/A"}
- Forma giuridica: ${invoice.legal_form || "N/A"}
- Periodicita IVA: ${invoice.iva_periodicity || "N/A"}

STATO AZIENDALE AGGREGATO:
- Fatture totali: ${companyStats.invoices_count ?? "N/A"}
- Movimenti bancari: ${companyStats.bank_tx_count ?? "N/A"}
- Totale da pagare: ${companyStats.total_to_pay ?? "N/A"}
- Totale da incassare: ${companyStats.total_to_collect ?? "N/A"}
- Totale scaduto: ${companyStats.overdue_total ?? "N/A"}
- Fatturato / volumi fatture YTD: ${companyStats.invoices_ytd ?? "N/A"}
- Saldo banca aggregato: ${companyStats.bank_balance ?? "N/A"}

CONTESTO FATTURA:
- Numero: ${invoice.number || "N/A"} del ${invoice.date || "N/A"}
- Direzione: ${invoice.direction === "in" ? "Passiva (ricevuta/acquisto)" : "Attiva (emessa/vendita)"}
- Importo: ${invoice.total_amount || "N/A"}
- Controparte: ${invoice.counterparty_name || "N/A"} (CF: ${invoice.fiscal_code || "N/A"}, P.IVA: ${invoice.vat_number || "N/A"})
- Note fattura: ${invoice.notes || "N/A"}

RIGHE COINVOLTE:
${lineContext || "(nessuna riga specifica)"}

ALERT / DUBBIO ATTIVO:
${alert_context || "(nessun alert specifico)"}

PIANO DEI CONTI DISPONIBILE:
${clip(chartContext, 3200)}

${kbContext ? `EVIDENZE KB / NORMATIVE:\n${kbContext}\n` : ""}
STORICO CHAT CONTESTUALE:
${historyContext || "(nessun messaggio precedente)"}

ISTRUZIONI OPERATIVE:
1. Rispondi in italiano, chiaro e professionale.
2. Non suggerire scorciatoie elusive o aggressive.
3. Ragiona come advisor laterale: puoi confermare la decisione corrente, chiedere chiarimenti oppure proporre una risoluzione applicabile.
4. Se proponi una risoluzione, falla solo quando hai una posizione abbastanza solida e rendi espliciti rischi, evidenze e impatto atteso.
5. Se proponi una risoluzione, includi un blocco JSON opzionale con questa struttura:
\`\`\`json
{"action":{"type":"apply_consultant_resolution","recommended_conclusion":"...","rationale_summary":"...","risk_level":"low|medium|high","supporting_evidence":[{"source":"kb","label":"...","detail":"..."}],"expected_impact":"...","line_updates":[{"line_id":"uuid","category_id":"uuid|null","account_id":"uuid|null","fiscal_flags":{},"decision_status":"finalized|needs_review|unassigned","reasoning_summary_final":"...","final_confidence":72,"note":"..."}]}}
\`\`\`
6. Il blocco JSON e opzionale. Se la situazione non e matura, fai solo consulenza testuale o chiedi chiarimenti.
7. Se usi memoria o storico, trattali come evidenze contestuali, non come storico confermato.`;

      const mode: ConsultingMode = consulting_mode === "fast" ? "fast" : "deep";
      const model = mode === "deep"
        ? (agentConfig?.model_escalation || agentConfig?.model || "gemini-2.5-pro")
        : (agentConfig?.model || "gemini-2.5-pro");
      const thinkingBudget = mode === "deep"
        ? (agentConfig?.thinking_budget_escalation ?? agentConfig?.thinking_budget ?? 24576)
        : (agentConfig?.thinking_budget ?? 4096);
      const temperature = agentConfig?.temperature ?? 0.1;
      const maxOutputTokens = agentConfig?.max_output_tokens || 4096;

      let responsePayload: { message: string; thinking: string } = { message: "", thinking: "" };
      try {
        const llmResp = await callLLM(prompt, {
          model,
          temperature,
          thinkingBudget: mode === "deep" ? thinkingBudget : 0,
          maxOutputTokens,
          systemPrompt
        }, { geminiKey, anthropicKey, openaiKey });
        
        responsePayload = {
          message: llmResp.text,
          thinking: llmResp.thinking || "",
        };
      } catch (err: any) {
        return json({ error: err.message }, 502);
      }

      const action = parseResolutionAction(responsePayload.message);
      const message = stripJsonBlock(responsePayload.message);

      return json({
        message,
        action,
        thinking: responsePayload.thinking || null,
        consultant_mode: mode,
        model_used: model,
      });
    } finally {
      await sql.end();
    }
  } catch (err: any) {
    console.error("[ai-fiscal-consultant] Error:", err);
    return json(
      { error: err.message || "Internal error", message: "Mi dispiace, si e verificato un errore. Riprova." },
      500,
    );
  }
});
