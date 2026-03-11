// fiscal-reviewer — Fiscal Review Agent (Revisore)
// Reviews ALL classified lines (from both deterministic + AI) and produces:
// 1. Validated/corrected fiscal_flags per line
// 2. Invoice-level fiscal alerts (notes) for user decisions
// Uses Gemini with high thinking for thorough fiscal analysis.

import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GEMINI_MODEL = "gemini-2.5-flash-preview-05-20";
const EMBEDDING_MODEL = "gemini-embedding-001";
const EXPECTED_DIMS = 3072;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/* ─── Types ──────────────────────────────── */

interface ClassifiedLine {
  line_id: string;
  description: string;
  total_price: number | null;
  category_name: string | null;
  account_code: string | null;
  account_name: string | null;
  confidence: number;
  fiscal_flags: {
    ritenuta_acconto: { aliquota: number; base: string } | null;
    reverse_charge: boolean;
    split_payment: boolean;
    bene_strumentale: boolean;
    deducibilita_pct: number;
    iva_detraibilita_pct: number;
    note: string | null;
  };
  source: string; // "rule" | "history" | "ai"
}

interface FiscalAlert {
  type: string;
  severity: "warning" | "info";
  title: string;
  description: string;
  current_choice: string;
  options: { label: string; fiscal_override: Record<string, unknown>; is_default: boolean }[];
  affected_lines: string[];
}

interface ReviewResult {
  line_id: string;
  fiscal_flags_corrected: ClassifiedLine["fiscal_flags"];
  issues: string[];
  confidence_adjustment: number; // +/- to add to original confidence
}

/* ─── Helpers ────────────────────────────── */

function toVectorLiteral(values: number[]): string {
  return `[${values.map((v) => (Number.isFinite(v) ? v.toFixed(8) : "0")).join(",")}]`;
}

function extractJsonSection(text: string, marker: string): string | null {
  const idx = text.indexOf(marker);
  if (idx < 0) return null;
  const afterMarker = text.slice(idx + marker.length);
  const start = afterMarker.indexOf("[");
  if (start < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < afterMarker.length; i++) {
    const ch = afterMarker[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "[") depth++;
    if (ch === "]") { depth--; if (depth === 0) return afterMarker.slice(start, i + 1); }
  }
  return null;
}

function extractFirstJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "[") depth++;
    if (ch === "]") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

/* ─── Main ───────────────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const dbUrl = (Deno.env.get("SUPABASE_DB_URL") ?? "").trim();
  const geminiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
  if (!dbUrl) return json({ error: "SUPABASE_DB_URL non configurato" }, 503);
  if (!geminiKey) return json({ error: "GEMINI_API_KEY non configurata" }, 503);

  let body: {
    company_id?: string;
    invoice_id?: string;
    lines?: ClassifiedLine[];
    direction?: string;
    counterparty_name?: string;
    counterparty_vat_key?: string;
  };
  try { body = await req.json(); } catch { return json({ error: "Body JSON non valido" }, 400); }

  const companyId = body.company_id;
  const invoiceId = body.invoice_id;
  const lines = body.lines || [];
  const direction = body.direction || "in";
  const counterpartyName = body.counterparty_name || "N.D.";
  const counterpartyVatKey = body.counterparty_vat_key || null;

  if (!companyId) return json({ error: "company_id richiesto" }, 400);
  if (!invoiceId) return json({ error: "invoice_id richiesto" }, 400);
  if (lines.length === 0) return json({ error: "lines vuote" }, 400);

  const sql = postgres(dbUrl, { max: 1 });

  try {
    // Counterparty info
    let counterpartyInfo = counterpartyName;
    let counterpartyLegalType = "";
    let counterpartyAteco = "";
    if (counterpartyVatKey) {
      const vatKey = counterpartyVatKey.toUpperCase().replace(/^IT/i, "").replace(/[^A-Z0-9]/gi, "");
      if (vatKey) {
        const [cp] = await sql`
          SELECT ateco_code, ateco_description, legal_type, business_sector
          FROM counterparties WHERE company_id = ${companyId} AND vat_key = ${vatKey} LIMIT 1`;
        if (cp) {
          counterpartyLegalType = cp.legal_type || "";
          counterpartyAteco = cp.ateco_code || "";
          const parts = [`P.IVA: ${counterpartyVatKey}`];
          if (cp.ateco_code) parts.push(`ATECO: ${cp.ateco_code} ${cp.ateco_description || ""}`);
          if (cp.legal_type) parts.push(`Tipo: ${cp.legal_type}`);
          if (cp.business_sector) parts.push(`Settore: ${cp.business_sector}`);
          counterpartyInfo += ` — ${parts.join(" — ")}`;
        }
      }
    }

    // RAG: Search fiscal knowledge base
    let kbSection = "";
    try {
      const queryText = lines.map((l) => l.description).join(" | ") + ` | ${counterpartyName}`;
      const embUrl = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${geminiKey}`;
      const embResp = await fetch(embUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `models/${EMBEDDING_MODEL}`,
          content: { parts: [{ text: queryText }] },
          taskType: "RETRIEVAL_QUERY",
          outputDimensionality: EXPECTED_DIMS,
        }),
      });
      const embData = await embResp.json();
      const queryVec = embData?.embedding?.values;
      if (Array.isArray(queryVec) && queryVec.length === EXPECTED_DIMS) {
        const vecLiteral = toVectorLiteral(queryVec);
        const atecoPrefix = counterpartyAteco ? counterpartyAteco.slice(0, 2) : "";
        const accCodes = lines.map((l) => l.account_code).filter(Boolean).map((c) => (c as string).slice(0, 3));

        const kbRows = await sql.unsafe(
          `SELECT title, content, category, normativa, fiscal_values
           FROM fiscal_knowledge
           WHERE active = true AND embedding IS NOT NULL
             AND (
               (1 - (embedding <=> $1::halfvec(3072))) >= 0.35
               OR ($2 != '' AND $2 = ANY(trigger_ateco_prefixes))
               OR (trigger_account_prefixes && $3::text[])
             )
           ORDER BY priority DESC, embedding <=> $1::halfvec(3072)
           LIMIT 6`,
          [vecLiteral, atecoPrefix, accCodes],
        );

        if (kbRows.length > 0) {
          kbSection = `\n=== NORMATIVA FISCALE RILEVANTE ===\n` +
            kbRows.map((r: any) => {
              let entry = `[${r.category}] ${r.title}\n${r.content}`;
              if (r.normativa?.length) entry += `\nRif: ${r.normativa.join(", ")}`;
              if (r.fiscal_values) entry += `\nValori: ${JSON.stringify(r.fiscal_values)}`;
              return entry;
            }).join("\n---\n") + `\n===\n`;
        }
      }
    } catch (e) {
      console.warn("[fiscal-reviewer] KB search failed:", e);
    }

    // Build prompt
    const lineEntries = lines.map((l, i) => {
      const ff = l.fiscal_flags;
      return `${i + 1}. [${l.line_id}] "${l.description}" tot=${l.total_price ?? "N/D"}
   → conto: ${l.account_code || "N/D"} (${l.account_name || "N/D"}) | cat: ${l.category_name || "N/D"} | conf: ${l.confidence} | source: ${l.source}
   → fiscale: deducib=${ff.deducibilita_pct}% IVA_detr=${ff.iva_detraibilita_pct}% ritenuta=${ff.ritenuta_acconto ? ff.ritenuta_acconto.aliquota + "%" : "no"} RC=${ff.reverse_charge} SP=${ff.split_payment} BS=${ff.bene_strumentale}${ff.note ? ` nota:"${ff.note}"` : ""}`;
    }).join("\n\n");

    const prompt = `Sei un REVISORE CONTABILE italiano senior. Devi controllare la classificazione fiscale di questa fattura.

CONTROPARTE: ${counterpartyInfo}
DIREZIONE: ${direction === "in" ? "PASSIVA (acquisto)" : "ATTIVA (vendita)"}
${kbSection}

RIGHE CLASSIFICATE (da commercialista):
${lineEntries}

IL TUO COMPITO:
1. Per ogni riga, VERIFICA i fiscal_flags. Correggi se necessario.
2. Genera ALERT per l'utente quando serve una decisione umana.

REGOLE DI VERIFICA:
- Ritenuta d'acconto: SOLO su compensi a professionisti individuali (persone fisiche). MAI su SRL, SPA, cooperative. Controlla il tipo legale della controparte.
- Bene strumentale: SOLO beni FISICI DUREVOLI > 516,46€. MAI su: canoni leasing, servizi, materiali di consumo, manodopera, utenze, affitti, noleggi.
- IVA indetraibile: auto non da trasporto 40%, telefonia 50%, rappresentanza 0% se > 50€.
- Reverse charge: solo settore edile tra imprese (ATECO 41-43), o acquisti intracomunitari.
- Split payment: solo verso PA (controlla ragione sociale).
- Deducibilità: auto non da trasporto 20%, telefonia 80%, ristorazione 75%.
- Coerenza: tutte le righe per lo stesso tipo di operazione devono avere le STESSE percentuali.

FORMATO OUTPUT (2 sezioni):

Sezione 1 — JSON array revisioni:
[{"line_id":"uuid","fiscal_flags_corrected":{"ritenuta_acconto":null,"reverse_charge":false,"split_payment":false,"bene_strumentale":false,"deducibilita_pct":100,"iva_detraibilita_pct":100,"note":null},"issues":["descrizione problema"],"confidence_adjustment":0}]

---ALERTS---
JSON array di alert fiscali per l'utente (solo se servono decisioni umane):
[{"type":"deducibilita"|"ritenuta"|"reverse_charge"|"split_payment"|"bene_strumentale"|"iva_indetraibile"|"general","severity":"warning"|"info","title":"titolo breve","description":"spiegazione per l'utente","current_choice":"scelta conservativa applicata","options":[{"label":"Opzione A","fiscal_override":{},"is_default":false},{"label":"Opzione B","fiscal_override":{},"is_default":true}],"affected_lines":["line_id1"]}]
Se nessun alert: []`;

    // Call Gemini with thinking for thorough analysis
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiKey}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 32768, temperature: 0.1 },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      await sql.end();
      return json({ error: `Gemini API ${resp.status}: ${errText.slice(0, 300)}` }, 502);
    }

    const data = await resp.json();
    const gParts = (data as any)?.candidates?.[0]?.content?.parts || [];
    let responseText = "";
    for (const part of gParts) { if (part.text && !part.thought) responseText += part.text; }

    // Parse reviews
    const reviewStr = extractFirstJsonArray(responseText);
    let reviews: ReviewResult[] = [];
    if (reviewStr) {
      try { reviews = JSON.parse(reviewStr); } catch { /* ignore */ }
    }

    // Parse alerts
    const alertStr = extractJsonSection(responseText, "---ALERTS---");
    let alerts: FiscalAlert[] = [];
    if (alertStr) {
      try { alerts = JSON.parse(alertStr); } catch { /* ignore */ }
    }

    await sql.end();

    return json({
      reviews,
      alerts,
      prompt_length: prompt.length,
    });
  } catch (err) {
    await sql.end().catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
});
