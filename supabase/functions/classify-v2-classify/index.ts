// classify-v2-classify — Stage B: Classification
// Takes understanding results from Stage A and assigns account, category, article.
// Only sees FILTERED chart of accounts (by section from Stage A).
// Produces: category_id, account_id, article_code, phase_code, confidence, fiscal_flags.

import postgres from "npm:postgres@3.4.5";
import {
  getCompanyMemoryBlock,
  getUserInstructionsBlock,
  type CompanyContext,
  type MemoryFact,
} from "../_shared/accounting-system-prompt.ts";

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

interface InputLine {
  line_id: string;
  description: string;
  quantity: number | null;
  unit_price: number | null;
  total_price: number | null;
  matched_groups: string[];
}

interface Understanding {
  line_id: string;
  operation_type: string;
  account_sections: string[];
  is_NOT: string[];
  reasoning: string;
}

interface FiscalFlags {
  ritenuta_acconto: { aliquota: number; base: string } | null;
  reverse_charge: boolean;
  split_payment: boolean;
  bene_strumentale: boolean;
  deducibilita_pct: number;
  iva_detraibilita_pct: number;
  note: string | null;
}

interface ClassifyResult {
  line_id: string;
  article_code: string | null;
  phase_code: string | null;
  category_id: string | null;
  category_name: string | null;
  account_id: string | null;
  account_code: string | null;
  confidence: number;
  reasoning: string;
  fiscal_flags: FiscalFlags;
  suggest_new_account?: {
    code: string; name: string; section: string; parent_code: string; reason: string;
  } | null;
  suggest_new_category?: {
    name: string; type: string; reason: string;
  } | null;
}

/* ─── Direction enforcement ──────────────── */

const SECTIONS_FOR_DIRECTION: Record<string, { primary: string[]; allowed: string[] }> = {
  in: {
    primary: ["cost_production", "cost_personnel", "depreciation", "other_costs"],
    allowed: ["cost_production", "cost_personnel", "depreciation", "other_costs", "financial", "extraordinary", "assets", "liabilities"],
  },
  out: {
    primary: ["revenue"],
    allowed: ["revenue", "financial", "extraordinary", "assets", "liabilities"],
  },
};

const CAT_TYPES_FOR_DIRECTION: Record<string, string[]> = {
  in: ["expense", "both"],
  out: ["revenue", "both"],
};

/* ─── Embedding helper ───────────────────── */

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
  if (!response.ok) throw new Error(`Gemini embedding error: ${payload?.error?.message || response.status}`);
  const values = payload?.embedding?.values;
  if (!Array.isArray(values) || values.length !== EXPECTED_DIMS) throw new Error("Bad embedding dims");
  return values.map((v: unknown) => Number(v));
}

/* ─── Extract JSON array ─────────────────── */

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
    lines?: InputLine[];
    understandings?: Understanding[];
    direction?: string;
    counterparty_name?: string;
    counterparty_vat_key?: string;
  };
  try { body = await req.json(); } catch { return json({ error: "Body JSON non valido" }, 400); }

  const companyId = body.company_id;
  const invoiceId = body.invoice_id;
  const lines = body.lines || [];
  const understandings = body.understandings || [];
  const direction = body.direction || "in";
  const counterpartyName = body.counterparty_name || "N.D.";
  const counterpartyVatKey = body.counterparty_vat_key || null;

  if (!companyId) return json({ error: "company_id richiesto" }, 400);
  if (!invoiceId) return json({ error: "invoice_id richiesto" }, 400);
  if (lines.length === 0) return json({ error: "lines vuote" }, 400);

  const sql = postgres(dbUrl, { max: 1 });

  try {
    // Build understanding map
    const underMap = new Map(understandings.map((u) => [u.line_id, u]));

    // Collect all needed sections from understandings
    const neededSections = new Set<string>();
    const dirSections = SECTIONS_FOR_DIRECTION[direction] || SECTIONS_FOR_DIRECTION["in"];
    for (const u of understandings) {
      for (const s of u.account_sections) {
        if (dirSections.allowed.includes(s)) neededSections.add(s);
      }
    }
    // Fallback: if no sections determined, use all allowed
    if (neededSections.size === 0) {
      for (const s of dirSections.allowed) neededSections.add(s);
    }

    const allowedCatTypes = CAT_TYPES_FOR_DIRECTION[direction] || CAT_TYPES_FOR_DIRECTION["in"];

    // ─── Load context in parallel ──────────────────────────────
    const [articles, categories, accounts, phases, companyRow] = await Promise.all([
      sql`SELECT id, code, name, description, keywords FROM articles WHERE company_id = ${companyId} AND active = true ORDER BY code`,
      sql`SELECT id, name, type FROM categories WHERE company_id = ${companyId} AND active = true AND type = ANY(${allowedCatTypes}::text[]) ORDER BY sort_order, name`,
      sql`SELECT id, code, name, section FROM chart_of_accounts WHERE company_id = ${companyId} AND active = true AND is_header = false AND section = ANY(${[...neededSections]}::text[]) ORDER BY code`,
      sql`SELECT id, article_id, code, name, phase_type, is_counting_point, invoice_direction FROM article_phases WHERE company_id = ${companyId} AND active = true ORDER BY article_id, sort_order`,
      sql`SELECT name, vat_number FROM companies WHERE id = ${companyId} LIMIT 1`,
    ]);

    console.log(`[classify-v2] Loaded: ${accounts.length} accounts (sections: ${[...neededSections].join(",")}), ${categories.length} cats, ${articles.length} articles`);

    // Counterparty info
    let counterpartyInfo = counterpartyName;
    let counterpartyAtecoFull = "";
    let counterpartyLegalType = "";
    if (counterpartyVatKey) {
      const vatKey = counterpartyVatKey.toUpperCase().replace(/^IT/i, "").replace(/[^A-Z0-9]/gi, "");
      if (vatKey) {
        const [cp] = await sql`
          SELECT ateco_code, ateco_description, business_sector, legal_type, address
          FROM counterparties WHERE company_id = ${companyId} AND vat_key = ${vatKey} LIMIT 1`;
        if (cp) {
          const parts = [`P.IVA: ${counterpartyVatKey}`];
          if (cp.ateco_code) { parts.push(`ATECO: ${cp.ateco_code} ${cp.ateco_description || ""}`); counterpartyAtecoFull = cp.ateco_code; }
          if (cp.business_sector) parts.push(`Settore: ${cp.business_sector}`);
          if (cp.legal_type) { parts.push(`Tipo: ${cp.legal_type}`); counterpartyLegalType = cp.legal_type; }
          if (cp.address) parts.push(`Sede: ${cp.address}`);
          counterpartyInfo += ` — ${parts.join(" — ")}`;
        }
      }
    }

    // Company context
    const companyContext: CompanyContext | undefined = companyRow.length > 0
      ? { company_name: companyRow[0].name, sector: "servizi", vat_number: companyRow[0].vat_number }
      : undefined;

    // User instructions
    const userInstructionsBlock = await getUserInstructionsBlock(sql, companyId);

    // Memory via embedding
    let memoryBlock = "";
    try {
      const queryText = lines.map((l) => l.description).join(" | ") + ` | ${counterpartyName}`;
      const queryVec = await callGeminiEmbedding(geminiKey, queryText);
      const vecLiteral = toVectorLiteral(queryVec);
      const memRows = await sql.unsafe(
        `SELECT fact_text, fact_type, (1 - (embedding <=> $1::halfvec(3072)))::float as similarity
         FROM company_memory
         WHERE company_id = $2 AND active = true AND embedding IS NOT NULL
         ORDER BY embedding <=> $1::halfvec(3072) LIMIT 10`,
        [vecLiteral, companyId],
      );
      const memFacts = (memRows as any[]).filter((m) => m.similarity >= 0.40)
        .map((m) => ({ fact_text: m.fact_text, fact_type: m.fact_type }));
      memoryBlock = getCompanyMemoryBlock(memFacts);
    } catch (e) {
      console.warn("[classify-v2] Memory embedding failed:", e);
    }

    // Cross-counterparty article history
    let articleHistorySection = "";
    try {
      const artHist = await sql`
        SELECT il.description, art.code as article_code, art.name as article_name,
               ap.code as phase_code, ap.name as phase_name, count(*)::int as count
        FROM invoice_line_articles ila
        JOIN articles art ON ila.article_id = art.id
        LEFT JOIN article_phases ap ON ila.phase_id = ap.id
        JOIN invoice_lines il ON ila.invoice_line_id = il.id
        JOIN invoices i ON ila.invoice_id = i.id
        WHERE ila.company_id = ${companyId} AND ila.verified = true AND i.direction = ${direction}
        GROUP BY il.description, art.code, art.name, ap.code, ap.name
        HAVING count(*) >= 2 ORDER BY count(*) DESC LIMIT 20`;
      if (artHist.length > 0) {
        articleHistorySection = `\nSTORICO ARTICOLI (pattern confermati):\n` +
          artHist.map((ah: any) => `- "${ah.description}" → art:${ah.article_code}${ah.phase_code ? ` fase:${ah.phase_code}` : ""} [${ah.count}x]`).join("\n");
      }
    } catch { /* ignore */ }

    // Counterparty history (top 15)
    let historySection = "";
    if (counterpartyVatKey) {
      const vatKey = counterpartyVatKey.toUpperCase().replace(/^IT/i, "").replace(/[^A-Z0-9]/gi, "");
      if (vatKey) {
        const hist = await sql`
          SELECT il.description, c.name as category_name, a.code as account_code, a.name as account_name
          FROM invoice_lines il
          JOIN invoices i ON il.invoice_id = i.id
          LEFT JOIN categories c ON il.category_id = c.id
          LEFT JOIN chart_of_accounts a ON il.account_id = a.id
          WHERE i.company_id = ${companyId} AND i.direction = ${direction}
            AND i.counterparty_id = (SELECT id FROM counterparties WHERE vat_key = ${vatKey} AND company_id = ${companyId} LIMIT 1)
            AND i.classification_status = 'confirmed'
            AND il.category_id IS NOT NULL
          ORDER BY i.date DESC LIMIT 15`;
        if (hist.length > 0) {
          historySection = `STORICO CONTROPARTE:\n` +
            hist.map((h: any) => `"${h.description}" → cat:${h.category_name}, conto:${h.account_code} ${h.account_name}`).join("\n");
        }
      }
    }

    // Build phases-by-article
    const phasesByArticle = new Map<string, typeof phases>();
    for (const p of phases as any[]) {
      if (!phasesByArticle.has(p.article_id)) phasesByArticle.set(p.article_id, []);
      phasesByArticle.get(p.article_id)!.push(p);
    }

    // Build compact sections for prompt
    const catSection = (categories as any[]).map((c) => `- ${c.id}: ${c.name} (${c.type})`).join("\n");
    const accSection = (accounts as any[]).map((a) => `- ${a.id}: ${a.code} ${a.name} (${a.section})`).join("\n");

    let artSection = "";
    for (const a of articles as any[]) {
      const ps = phasesByArticle.get(a.id);
      const kwPart = a.keywords?.length ? ` [${a.keywords.join(", ")}]` : "";
      if (ps && ps.length > 0) {
        artSection += `- ${a.code} (${a.name})${kwPart}:\n${ps.map((p: any) => `  ${p.code}: ${p.name}`).join("\n")}\n`;
      } else {
        artSection += `- ${a.code} (${a.name})${kwPart}\n`;
      }
    }

    // Lines with understanding context
    const lineEntries = lines.map((l, i) => {
      const u = underMap.get(l.line_id);
      const uCtx = u ? ` → COMPRENSIONE: "${u.operation_type}" sections=${u.account_sections.join(",")}${u.is_NOT.length ? ` NOT=[${u.is_NOT.join("; ")}]` : ""}` : "";
      return `${i + 1}. [${l.line_id}] "${l.description || "N/D"}" qty=${l.quantity ?? "N/D"} tot=${l.total_price ?? "N/D"}${uCtx}`;
    }).join("\n");

    // Build prompt
    const prompt = `Sei un COMMERCIALISTA SENIOR italiano. Classifica ogni riga della fattura.

${companyContext ? `AZIENDA: ${companyContext.company_name} (P.IVA: ${companyContext.vat_number})` : ""}
CONTROPARTE: ${counterpartyInfo}
DIREZIONE: ${direction === "in" ? "PASSIVA (acquisto)" : "ATTIVA (vendita)"}
${userInstructionsBlock}
${memoryBlock}

IMPORTANTE — COMPRENSIONE (Stage A):
Ogni riga ha una "COMPRENSIONE" allegata che ti dice cos'è l'operazione e in quali sezioni cercare il conto.
RISPETTA le sezioni indicate. Se la comprensione dice sections=cost_production, NON scegliere conti in assets.
Se la comprensione dice NOT=["vendita di pozzolana"], allora NON classificare come vendita.

CATEGORIE:
${catSection}

CONTI (filtrati per le sezioni rilevanti):
${accSection}

${artSection ? `ARTICOLI:\n${artSection}` : ""}
${historySection}
${articleHistorySection}

RIGHE:
${lineEntries}

REGOLE:
- category_id e account_id: SEMPRE UUID dalla lista sopra
- article_code + phase_code: solo se il materiale corrisponde
- confidence 0-100 (dubbio → bassa, mai confidence alta su scelte incerte)
- fiscal_flags per OGNI riga: ritenuta_acconto (solo professionisti), reverse_charge, split_payment, bene_strumentale (solo beni FISICI > 516€), deducibilita_pct, iva_detraibilita_pct, note
- Righe con tot=0: informative, confidence 30-50

Rispondi con JSON array (no markdown):
[{"line_id":"uuid","article_code":"CODE"|null,"phase_code":"code"|null,"category_id":"uuid","category_name":"nome","account_id":"uuid","account_code":"codice","confidence":0-100,"reasoning":"max 30 parole","fiscal_flags":{"ritenuta_acconto":null,"reverse_charge":false,"split_payment":false,"bene_strumentale":false,"deducibilita_pct":100,"iva_detraibilita_pct":100,"note":null},"suggest_new_account":null,"suggest_new_category":null}]`;

    // Call Gemini
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiKey}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 32768, temperature: 0.2 },
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
    for (const part of gParts) { if (part.text) responseText += part.text; }

    const jsonStr = extractFirstJsonArray(responseText);
    let results: ClassifyResult[] = [];
    if (jsonStr) {
      try {
        results = JSON.parse(jsonStr);
      } catch (e) {
        console.error("[classify-v2] JSON parse error:", e);
      }
    }

    // Validate UUIDs — ensure account_id and category_id exist in our loaded data
    const validAccIds = new Set((accounts as any[]).map((a) => a.id));
    const validCatIds = new Set((categories as any[]).map((c) => c.id));

    for (const r of results) {
      // If AI returned invalid UUID, try to resolve by code/name
      if (r.account_id && !validAccIds.has(r.account_id)) {
        if (r.account_code) {
          const match = (accounts as any[]).find((a) => a.code === r.account_code);
          if (match) r.account_id = match.id;
          else r.account_id = null;
        } else {
          r.account_id = null;
        }
      }
      if (r.category_id && !validCatIds.has(r.category_id)) {
        if (r.category_name) {
          const match = (categories as any[]).find((c) => c.name.toLowerCase() === r.category_name!.toLowerCase());
          if (match) r.category_id = match.id;
          else r.category_id = null;
        } else {
          r.category_id = null;
        }
      }
    }

    await sql.end();

    return json({
      classifications: results,
      prompt_length: prompt.length,
      accounts_shown: accounts.length,
      categories_shown: categories.length,
    });
  } catch (err) {
    await sql.end().catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
});
