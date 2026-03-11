// classify-v2-understand — Stage A: Comprehension
// "What is this operation?" — NO chart of accounts, NO classification.
// Returns: operation type, account section, is_NOT list, and reasoning for each line.
// This narrows the search space for Stage B (classify-v2-classify).

import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GEMINI_MODEL = "gemini-2.5-flash-preview-05-20";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/* ─── Types ──────────────────────────────── */

interface InputLine {
  line_id: string;
  description: string;
  quantity: number | null;
  unit_price: number | null;
  total_price: number | null;
  matched_groups: string[]; // from deterministic step
}

interface UnderstandingResult {
  line_id: string;
  operation_type: string;        // e.g., "acquisto materiali edili", "servizio di trasporto"
  account_sections: string[];    // e.g., ["cost_production"], narrows chart_of_accounts for Stage B
  is_NOT: string[];             // anti-patterns: what this is NOT
  reasoning: string;
}

/* ─── Valid sections ─────────────────────── */

const ALL_SECTIONS = [
  "assets", "liabilities", "equity", "revenue",
  "cost_production", "cost_personnel", "depreciation", "other_costs",
  "financial", "extraordinary",
];

const SECTIONS_FOR_DIRECTION: Record<string, string[]> = {
  in: ["cost_production", "cost_personnel", "depreciation", "other_costs", "financial", "extraordinary", "assets", "liabilities"],
  out: ["revenue", "financial", "extraordinary", "assets", "liabilities"],
};

/* ─── Extract JSON array from text ───────── */

function extractFirstJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
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
    lines?: InputLine[];
    direction?: string;
    counterparty_name?: string;
    counterparty_vat_key?: string;
  };
  try { body = await req.json(); } catch { return json({ error: "Body JSON non valido" }, 400); }

  const companyId = body.company_id;
  const lines = body.lines || [];
  const direction = body.direction || "in";
  const counterpartyName = body.counterparty_name || "N.D.";
  const counterpartyVatKey = body.counterparty_vat_key || null;

  if (!companyId) return json({ error: "company_id richiesto" }, 400);
  if (lines.length === 0) return json({ error: "lines vuote" }, 400);

  const sql = postgres(dbUrl, { max: 1 });

  try {
    // Load counterparty ATECO info
    let counterpartyInfo = counterpartyName;
    if (counterpartyVatKey) {
      const vatKey = counterpartyVatKey.toUpperCase().replace(/^IT/i, "").replace(/[^A-Z0-9]/gi, "");
      if (vatKey) {
        const [cp] = await sql`
          SELECT ateco_code, ateco_description, business_sector, legal_type
          FROM counterparties
          WHERE company_id = ${companyId} AND vat_key = ${vatKey}
          LIMIT 1`;
        if (cp) {
          const parts = [`P.IVA: ${counterpartyVatKey}`];
          if (cp.ateco_code) parts.push(`ATECO: ${cp.ateco_code} ${cp.ateco_description || ""}`);
          if (cp.business_sector) parts.push(`Settore: ${cp.business_sector}`);
          if (cp.legal_type) parts.push(`Tipo: ${cp.legal_type}`);
          counterpartyInfo += ` — ${parts.join(" — ")}`;
        }
      }
    }

    // Load keyword group names for matched codes
    const allGroupCodes = [...new Set(lines.flatMap((l) => l.matched_groups || []))];
    let groupLabels: Record<string, string> = {};
    if (allGroupCodes.length > 0) {
      const gRows = await sql`
        SELECT group_code, group_name FROM operation_keyword_groups
        WHERE group_code = ANY(${allGroupCodes}::text[])`;
      for (const g of gRows) groupLabels[g.group_code] = g.group_name;
    }

    // Valid sections for this direction
    const validSections = SECTIONS_FOR_DIRECTION[direction] || SECTIONS_FOR_DIRECTION["in"];

    // Build prompt
    const lineEntries = lines.map((l, i) => {
      const groups = (l.matched_groups || []).map((c) => groupLabels[c] || c).join(", ");
      return `${i + 1}. [${l.line_id}] "${l.description || "N/D"}" qty=${l.quantity ?? "N/D"} tot=${l.total_price ?? "N/D"}${groups ? ` GRUPPI_KEYWORD=[${groups}]` : ""}`;
    }).join("\n");

    const prompt = `Sei un analista contabile italiano. Il tuo compito è CAPIRE ogni riga di fattura — NON classificarla.

CONTROPARTE: ${counterpartyInfo}
DIREZIONE FATTURA: ${direction === "in" ? "PASSIVA (acquisto)" : "ATTIVA (vendita)"}
SEZIONI VALIDE: ${validSections.join(", ")}

Per ogni riga, determina:
1. OPERATION_TYPE: descrizione breve (max 8 parole) dell'operazione economica. Es: "acquisto materiali edili", "servizio di trasporto conto terzi", "canone leasing escavatore"
2. ACCOUNT_SECTIONS: le 1-3 sezioni del piano dei conti dove si trova il conto corretto. Scegli tra: ${validSections.join(", ")}
   - REGOLA: per fatture passive, la maggior parte va in cost_production/other_costs. assets SOLO per beni strumentali > 516€. financial SOLO per interessi/commissioni bancarie.
   - REGOLA: per fatture attive, la maggior parte va in revenue.
3. IS_NOT: lista di 2-4 cose che questa riga NON è (anti-pattern per evitare errori comuni). Es: se è "trasporto pozzolana" → is_NOT: ["vendita di pozzolana", "acquisto di pozzolana", "noleggio mezzi"]. Se è "canone leasing" → is_NOT: ["acquisto bene strumentale", "rata mutuo", "noleggio"]
4. REASONING: ragionamento breve (max 20 parole)

ATTENZIONE AI GRUPPI KEYWORD: Se una riga ha GRUPPI_KEYWORD, quei gruppi ti dicono il tipo di operazione. Rispettali. Es: se GRUPPI_KEYWORD=[Vendita / Cessione], allora è una vendita, NON un acquisto.

RIGHE:
${lineEntries}

Rispondi con un JSON array (no markdown):
[{"line_id":"uuid","operation_type":"...","account_sections":["section1"],"is_NOT":["non è X","non è Y"],"reasoning":"..."}]`;

    // Call Gemini
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiKey}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 16384,
          temperature: 0.1,
        },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      await sql.end();
      return json({ error: `Gemini API ${resp.status}: ${errText.slice(0, 300)}` }, 502);
    }

    const data = await resp.json();
    const parts = (data as any)?.candidates?.[0]?.content?.parts || [];
    let responseText = "";
    for (const part of parts) {
      if (part.text) responseText += part.text;
    }

    // Parse response
    const jsonStr = extractFirstJsonArray(responseText);
    let results: UnderstandingResult[] = [];
    if (jsonStr) {
      try {
        const parsed = JSON.parse(jsonStr);
        results = (parsed as any[]).map((r) => ({
          line_id: r.line_id,
          operation_type: r.operation_type || "operazione generica",
          account_sections: (r.account_sections || []).filter((s: string) => ALL_SECTIONS.includes(s)),
          is_NOT: r.is_NOT || r.is_not || [],
          reasoning: r.reasoning || "",
        }));
      } catch (e) {
        console.error("[understand] JSON parse error:", e);
      }
    }

    // Ensure all lines have a result (fallback for missing)
    const resultMap = new Map(results.map((r) => [r.line_id, r]));
    const finalResults = lines.map((l) => {
      const existing = resultMap.get(l.line_id);
      if (existing) return existing;
      // Fallback: generic understanding
      return {
        line_id: l.line_id,
        operation_type: "operazione generica",
        account_sections: direction === "in" ? ["cost_production", "other_costs"] : ["revenue"],
        is_NOT: [],
        reasoning: "Fallback — AI non ha restituito risultato per questa riga",
      };
    });

    await sql.end();

    return json({
      understandings: finalResults,
      prompt_length: prompt.length,
    });
  } catch (err) {
    await sql.end().catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
});
