import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SONNET_MODEL = "claude-sonnet-4-6";
const EMBEDDING_MODEL = "gemini-embedding-001";
const EXPECTED_DIMS = 3072;

/* ─── helpers ──────────────────────────────── */

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

/* ─── Gemini embedding ─────────────────────── */

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
  if (!response.ok)
    throw new Error(`Gemini embedding error: ${payload?.error?.message || response.status}`);
  const values = payload?.embedding?.values;
  if (!Array.isArray(values) || values.length !== EXPECTED_DIMS)
    throw new Error("Bad embedding dims");
  return values;
}

/* ─── main ─────────────────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    const dbUrl = Deno.env.get("SUPABASE_DB_URL");
    if (!anthropicKey) return json({ error: "ANTHROPIC_API_KEY not set" }, 500);
    if (!dbUrl) return json({ error: "SUPABASE_DB_URL not set" }, 500);

    const body = await req.json();
    const {
      invoice_id,
      line_ids = [],
      alert_context = "",
      messages = [],
      company_id,
    } = body as {
      invoice_id: string;
      line_ids: string[];
      alert_context: string;
      messages: { role: "user" | "assistant"; content: string }[];
      company_id: string;
    };

    if (!invoice_id || !company_id) {
      return json({ error: "invoice_id and company_id required" }, 400);
    }

    const sql = postgres(dbUrl, { max: 2 });

    try {
      // ─── Load invoice context ────────────────────
      const [invoiceRows] = await Promise.all([
        sql`
          SELECT i.numero, i.data_documento, i.direction, i.total_amount,
                 c.name AS counterparty_name, c.codice_fiscale, c.partita_iva,
                 co.name AS company_name, co.vat_number AS company_vat
          FROM invoices i
          LEFT JOIN counterparties c ON i.counterparty_id = c.id
          LEFT JOIN companies co ON i.company_id = co.id
          WHERE i.id = ${invoice_id}
          LIMIT 1
        `,
      ]);
      const inv = invoiceRows[0];
      if (!inv) return json({ error: "Invoice not found" }, 404);

      // ─── Load affected lines ────────────────────
      let linesContext = "";
      if (line_ids.length > 0) {
        const lineRows = await sql`
          SELECT il.id, il.descrizione, il.importo, il.aliquota_iva,
                 cat.name AS category_name, acc.name AS account_name, acc.code AS account_code,
                 il.fiscal_flags, il.classification_reasoning, il.fiscal_reasoning
          FROM invoice_lines il
          LEFT JOIN categories cat ON il.category_id = cat.id
          LEFT JOIN chart_of_accounts acc ON il.account_id = acc.id
          WHERE il.id = ANY(${line_ids})
        `;
        linesContext = lineRows
          .map(
            (r: any) =>
              `- "${clip(r.descrizione, 200)}" | ${r.importo}€ IVA${r.aliquota_iva || "N/A"}% | Cat: ${r.category_name || "N/A"} | Conto: ${r.account_code || "N/A"} ${r.account_name || "N/A"} | Fiscal: ${JSON.stringify(r.fiscal_flags || {})} | Reasoning: ${clip(r.classification_reasoning, 300)} | Fiscal Review: ${clip(r.fiscal_reasoning, 300)}`
          )
          .join("\n");
      }

      // ─── Load chart of accounts (top-level) ────────────────────
      const coaRows = await sql`
        SELECT code, name, section
        FROM chart_of_accounts
        WHERE company_id = ${company_id}
          AND parent_id IS NOT NULL
        ORDER BY code
        LIMIT 200
      `;
      const coaContext = coaRows
        .map((r: any) => `${r.code} ${r.name} (${r.section})`)
        .join("\n");

      // ─── RAG: KB chunks ────────────────────
      let kbContext = "";
      if (geminiKey) {
        try {
          const ragQuery = `${alert_context} ${inv.counterparty_name || ""} ${linesContext.slice(0, 500)}`;
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
            [vecLit, company_id]
          );

          const relevant = (docChunks as any[]).filter((c) => c.similarity >= 0.40);
          if (relevant.length > 0) {
            kbContext = relevant
              .map(
                (c: any) =>
                  `[${c.doc_title}${c.section_title ? ` > ${c.section_title}` : ""}] (sim=${c.similarity.toFixed(2)}):\n${clip(c.content, 1000)}`
              )
              .join("\n\n");
          }
          console.log(`[ai-fiscal-consultant] RAG: ${relevant.length} relevant chunks`);
        } catch (e) {
          console.warn("[ai-fiscal-consultant] RAG failed:", e);
        }
      }

      // ─── Build system prompt ────────────────────
      const systemPrompt = `Sei un consulente fiscale italiano esperto. Aiuti l'utente a prendere decisioni fiscali corrette sulle fatture della sua azienda.

CONTESTO AZIENDA:
- Azienda: ${inv.company_name || "N/A"} (P.IVA: ${inv.company_vat || "N/A"})

CONTESTO FATTURA:
- Numero: ${inv.numero || "N/A"} del ${inv.data_documento || "N/A"}
- Direzione: ${inv.direction === "in" ? "Passiva (ricevuta/acquisto)" : "Attiva (emessa/vendita)"}
- Importo: ${inv.total_amount || "N/A"}€
- Controparte: ${inv.counterparty_name || "N/A"} (CF: ${inv.codice_fiscale || "N/A"}, P.IVA: ${inv.partita_iva || "N/A"})

RIGHE COINVOLTE:
${linesContext || "(nessuna riga specifica)"}

ALERT FISCALE IN DISCUSSIONE:
${alert_context || "(nessun alert specifico)"}

PIANO DEI CONTI DISPONIBILE:
${clip(coaContext, 3000)}

${kbContext ? `DOCUMENTAZIONE FISCALE RILEVANTE:\n${kbContext}` : ""}

ISTRUZIONI:
1. Rispondi in italiano, in modo chiaro e professionale
2. Spiega sempre il ragionamento fiscale (articoli di legge, prassi, circolari)
3. Privilegia l'approccio CONSERVATIVO — in caso di dubbio, suggerisci la scelta più prudente
4. Quando proponi una decisione, includi un blocco JSON con la struttura:
   \`\`\`json
   {"action":{"type":"apply_fiscal_override","fiscal_override":{...},"note":"...","reasoning":"...","affected_line_ids":[...]}}
   \`\`\`
5. Il blocco JSON è OPZIONALE — includilo solo quando hai una raccomandazione chiara e l'utente chiede di applicarla
6. Se non sei sicuro, chiedi chiarimenti all'utente prima di proporre un'azione`;

      // ─── Build Claude messages ────────────────────
      const claudeMessages = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      // ─── Call Claude ────────────────────
      console.log(`[ai-fiscal-consultant] Calling ${SONNET_MODEL} with ${claudeMessages.length} messages`);

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: SONNET_MODEL,
          max_tokens: 2048,
          system: systemPrompt,
          messages: claudeMessages,
        }),
      });

      if (!response.ok) {
        const err = await response.text().catch(() => "");
        throw new Error(`Anthropic API ${response.status}: ${clip(err, 300)}`);
      }

      const data = await response.json();
      const textBlocks = (data.content || []).filter(
        (b: { type: string }) => b.type === "text"
      );
      const fullText = textBlocks.map((b: { text: string }) => b.text).join("\n");

      // ─── Parse optional action from response ────────────────────
      let action = null;
      const jsonMatch = fullText.match(/```json\s*(\{[\s\S]*?\})\s*```/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1]);
          if (parsed.action && parsed.action.type === "apply_fiscal_override") {
            action = parsed.action;
          }
        } catch {
          console.warn("[ai-fiscal-consultant] JSON parse failed in response");
        }
      }

      // Remove the JSON block from the displayed message
      const message = fullText.replace(/```json\s*\{[\s\S]*?\}\s*```/g, "").trim();

      console.log(
        `[ai-fiscal-consultant] Response: ${message.length} chars, action=${action ? "yes" : "no"}, tokens=${data.usage?.input_tokens || 0}+${data.usage?.output_tokens || 0}`
      );

      return json({ message, action });
    } finally {
      await sql.end();
    }
  } catch (err: any) {
    console.error("[ai-fiscal-consultant] Error:", err);
    return json(
      { error: err.message || "Internal error", message: "Mi dispiace, si è verificato un errore. Riprova." },
      500
    );
  }
});
