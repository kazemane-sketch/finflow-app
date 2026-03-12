// classify-v2-cdc — Stage C: Cost Center Assignment
// Assigns projects (centri di costo) to ALL lines — both deterministic-resolved and AI-classified.
// Lighter model, simpler prompt. Only needs line descriptions + project list.

import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GEMINI_MODEL = "gemini-2.5-flash";

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
  total_price: number | null;
  category_name?: string;
  account_code?: string;
}

interface CdcResult {
  line_id: string;
  cost_center_allocations: { project_id: string; percentage: number }[];
  reasoning: string;
}

/* ─── Extract JSON ───────────────────────── */

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

/** Robust JSON extractor: handles markdown fences, arrays, and objects */
function extractJson(text: string): any {
  let clean = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  try { return JSON.parse(clean); } catch { /* continue */ }
  const arrMatch = clean.match(/\[[\s\S]*\]/);
  if (arrMatch) try { return JSON.parse(arrMatch[0]); } catch { /* continue */ }
  const objMatch = clean.match(/\{[\s\S]*\}/);
  if (objMatch) try { return JSON.parse(objMatch[0]); } catch { /* continue */ }
  throw new Error("Cannot parse JSON from Gemini response");
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
  };
  try { body = await req.json(); } catch { return json({ error: "Body JSON non valido" }, 400); }

  const companyId = body.company_id;
  const lines = body.lines || [];
  const direction = body.direction || "in";
  const counterpartyName = body.counterparty_name || "N.D.";
  const invoiceNotes = body.invoice_notes || null;
  const invoiceCausale = body.invoice_causale || null;

  if (!companyId) return json({ error: "company_id richiesto" }, 400);
  if (lines.length === 0) return json({ error: "lines vuote" }, 400);

  const sql = postgres(dbUrl, { max: 1 });

  try {
    // Load active projects
    const projects = await sql`
      SELECT id, code, name, description
      FROM projects
      WHERE company_id = ${companyId} AND status = 'active'
      ORDER BY code`;

    // If no projects exist, skip CdC assignment entirely
    if (projects.length === 0) {
      await sql.end();
      return json({
        allocations: lines.map((l) => ({
          line_id: l.line_id,
          cost_center_allocations: [],
          reasoning: "Nessun CdC attivo",
        })),
        skipped: true,
      });
    }

    // Build prompt
    const projectList = projects.map((p: any) =>
      `- ${p.id}: ${p.code} "${p.name}"${p.description ? ` (${p.description.slice(0, 60)})` : ""}`
    ).join("\n");

    const lineEntries = lines.map((l, i) =>
      `${i + 1}. [${l.line_id}] "${l.description}" tot=${l.total_price ?? "N/D"}${l.category_name ? ` cat:${l.category_name}` : ""}${l.account_code ? ` conto:${l.account_code}` : ""}`
    ).join("\n");

    // Invoice notes + causale context
    let invoiceContextBlock = "";
    if (invoiceNotes || invoiceCausale) {
      invoiceContextBlock = "\n=== INFORMAZIONI AGGIUNTIVE FATTURA ===\n";
      if (invoiceCausale) invoiceContextBlock += `Causale fattura (dall'XML): ${invoiceCausale}\n`;
      if (invoiceNotes) invoiceContextBlock += `Note utente: ${invoiceNotes}\n`;
      invoiceContextBlock += "Usa queste informazioni per capire meglio la natura dell'operazione.\n===\n";
    }

    const prompt = `Sei un controller di gestione. Assegna i centri di costo (CdC) alle righe di questa fattura.

CONTROPARTE: ${counterpartyName}
DIREZIONE: ${direction === "in" ? "Acquisto" : "Vendita"}
${invoiceContextBlock}
CdC DISPONIBILI:
${projectList}

RIGHE:
${lineEntries}

REGOLE:
- Assegna SOLO se c'è un segnale chiaro (nome progetto, commessa, cantiere nella descrizione)
- Se non sei sicuro, lascia vuoto (cost_center_allocations: [])
- Una riga può essere divisa tra più CdC (percentuali che sommano a 100)
- Spese generali (utenze, telefonia, cancelleria) di solito NON hanno CdC specifico
- Trasporti, materiali, manodopera: spesso legati a una commessa specifica

Rispondi con JSON array (no markdown):
[{"line_id":"uuid","cost_center_allocations":[{"project_id":"uuid","percentage":100}],"reasoning":"max 15 parole"}]`;

    // Call Gemini
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiKey}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 8192, temperature: 0.1 },
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
    for (const part of parts) { if (part.text) responseText += part.text; }

    let results: CdcResult[] = [];
    const jsonStr = extractFirstJsonArray(responseText);
    if (jsonStr) {
      try { results = JSON.parse(jsonStr); } catch { /* ignore */ }
    }
    if (results.length === 0) {
      try {
        const fallback = extractJson(responseText);
        results = Array.isArray(fallback) ? fallback : [fallback];
        console.warn(`[cdc] extractFirstJsonArray failed, extractJson fallback OK: ${results.length} items`);
      } catch { /* both failed */ }
    }

    // Validate project_ids
    const validProjectIds = new Set(projects.map((p: any) => p.id));
    for (const r of results) {
      r.cost_center_allocations = (r.cost_center_allocations || []).filter(
        (a) => validProjectIds.has(a.project_id) && a.percentage > 0
      );
    }

    // Ensure all lines have a result
    const resultMap = new Map(results.map((r) => [r.line_id, r]));
    const finalResults = lines.map((l) => {
      const existing = resultMap.get(l.line_id);
      if (existing) return existing;
      return { line_id: l.line_id, cost_center_allocations: [], reasoning: "Non assegnato" };
    });

    await sql.end();
    return json({
      allocations: finalResults,
      skipped: false,
      _debug: {
        invoice_notes: invoiceNotes ? invoiceNotes.slice(0, 200) : null,
        invoice_causale: invoiceCausale ? invoiceCausale.slice(0, 200) : null,
      },
    });
  } catch (err) {
    await sql.end().catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
});
