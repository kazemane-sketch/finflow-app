// fiscal-reviewer — Fiscal Review Agent (Revisore)
// Reviews ALL classified lines (from both deterministic + AI) and produces:
// 1. Validated/corrected fiscal_flags per line
// 2. Invoice-level fiscal alerts (notes) for user decisions
// Uses Gemini with high thinking for thorough fiscal analysis.
//
// v2 (Fase 3): Pre-applies fiscal_decisions (user choices on past alerts).
// Lines with pre-applied decisions are communicated to Gemini as "already decided".

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
  fiscal_flags_source?: string; // "rule_confirmed" | "to_review"
  fiscal_flags_preset?: Record<string, unknown> | null;
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

/* ─── Subject keyword extraction (mirrors frontend) ── */

const STOPWORDS = new Set([
  "per", "con", "del", "della", "dei", "delle", "dal", "dalla",
  "nel", "nella", "sul", "sulla", "che", "non", "una", "uno",
  "gli", "alla", "alle", "tra", "fra", "come", "anche", "più",
  "rif", "vostro", "nostro", "sig", "spett", "fattura", "fatt",
  "numero", "num", "art", "cod", "tipo", "data", "periodo",
  "mese", "anno", "totale", "importo", "prezzo", "costo",
  "netto", "lordo", "iva", "inclusa", "esclusa",
]);

function extractSubjectKeywords(description: string): string[] {
  let desc = description.toLowerCase();
  desc = desc.replace(/\b[a-z]{2}\d{3}[a-z]{2}\b/gi, "");
  desc = desc.replace(/\b\d+([.,]\d+)?\s*(eur|euro|€|kg|lt|ton|pz|nr|q\.li)?\b/gi, "");
  desc = desc.replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, "");
  desc = desc.replace(/[,;:()[\]{}'"/\\.\-]/g, " ");
  desc = desc.replace(/\s+/g, " ").trim();
  const words = desc.split(" ").filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 5);
}

function findBestOperationGroup(
  descLower: string,
  groups: { group_code: string; keywords: string[] }[],
): string | null {
  let bestCode: string | null = null;
  let bestLen = 0;
  for (const g of groups) {
    for (const kw of g.keywords as string[]) {
      const kwLower = kw.toLowerCase();
      if (descLower.includes(kwLower) && kwLower.length > bestLen) {
        bestCode = g.group_code;
        bestLen = kwLower.length;
      }
    }
  }
  return bestCode;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((w) => b.has(w)).length;
  const union = new Set([...a, ...b]).size;
  return union > 0 ? intersection / union : 0;
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
    // ─── Counterparty info ──────────────────────────
    let counterpartyInfo = counterpartyName;
    let counterpartyLegalType = "";
    let counterpartyAteco = "";
    let vatKey: string | null = null;
    if (counterpartyVatKey) {
      vatKey = counterpartyVatKey.toUpperCase().replace(/^IT/i, "").replace(/[^A-Z0-9]/gi, "");
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

    // ─── Pre-resolve fiscal decisions ──────────────────
    // Load fiscal_decisions for this counterparty and pre-apply matching ones
    const preResolvedFiscal = new Map<string, {
      alert_type: string;
      fiscal_override: Record<string, unknown>;
      chosen_option: string;
      times_applied: number;
    }[]>();

    if (vatKey) {
      const fiscalDecisions = await sql`
        SELECT id, operation_group_code, subject_keywords, alert_type,
               chosen_option_label, fiscal_override, times_applied
        FROM fiscal_decisions
        WHERE company_id = ${companyId}
          AND counterparty_vat_key = ${vatKey}
          AND direction = ${direction}`;

      if (fiscalDecisions.length > 0) {
        // Load operation keyword groups for group matching
        const opGroups = await sql`
          SELECT group_code, keywords FROM operation_keyword_groups WHERE active = true`;

        for (const line of lines) {
          const descLower = line.description.toLowerCase();
          const lineGroupCode = findBestOperationGroup(descLower, opGroups);
          if (!lineGroupCode) continue;

          const lineSubjectKw = extractSubjectKeywords(line.description);
          const lineSubjectSet = new Set(lineSubjectKw);

          const lineDecisions: typeof preResolvedFiscal extends Map<string, infer V> ? V : never = [];

          for (const dec of fiscalDecisions) {
            if (dec.operation_group_code !== lineGroupCode) continue;

            const decSubjectSet = new Set((dec.subject_keywords as string[]) || []);

            // Match subject keywords (Jaccard >= 0.80)
            const jaccard = jaccardSimilarity(lineSubjectSet, decSubjectSet);
            if (jaccard < 0.80) continue;

            lineDecisions.push({
              alert_type: dec.alert_type,
              fiscal_override: dec.fiscal_override as Record<string, unknown>,
              chosen_option: dec.chosen_option_label,
              times_applied: dec.times_applied,
            });

            // Increment times_applied (fire-and-forget)
            sql`UPDATE fiscal_decisions SET times_applied = times_applied + 1, last_applied_at = now() WHERE id = ${dec.id}`.catch(() => {});
          }

          if (lineDecisions.length > 0) {
            preResolvedFiscal.set(line.line_id, lineDecisions);
          }
        }
      }
    }

    // ─── RAG: Search fiscal knowledge base ────────────
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

    // ─── Build pre-resolved section for prompt ────────
    let preResolvedSection = "";
    const preResolvedLineIds = new Set<string>();
    const preResolvedAlertTypes = new Map<string, Set<string>>(); // line_id → Set<alert_type>

    if (preResolvedFiscal.size > 0) {
      const preLines: string[] = [];
      for (const [lineId, decs] of preResolvedFiscal) {
        const line = lines.find((l) => l.line_id === lineId);
        if (!line) continue;
        preResolvedLineIds.add(lineId);
        const alertTypes = new Set<string>();
        for (const d of decs) {
          alertTypes.add(d.alert_type);
          preLines.push(
            `- [${lineId}] "${line.description.slice(0, 80)}" → ${d.alert_type}: ${d.chosen_option} (applicata ${d.times_applied} volte)`
          );
        }
        preResolvedAlertTypes.set(lineId, alertTypes);
      }
      preResolvedSection = `\n=== DECISIONI FISCALI GIA' PRESE DALL'UTENTE ===
Per le seguenti righe, la decisione fiscale è già stata presa e confermata dall'utente:
${preLines.join("\n")}
NON generare alert per queste righe su questi tipi. Applica i valori fiscali già decisi.
===\n`;
    }

    // ─── Build lines with rule-confirmed flags section ──
    let ruleConfirmedSection = "";
    const ruleConfirmedLineIds = new Set<string>();
    const ruleConfirmedLines = lines.filter(
      (l) => l.fiscal_flags_source === "rule_confirmed" && l.fiscal_flags_preset
    );
    if (ruleConfirmedLines.length > 0) {
      ruleConfirmedLineIds.add(...ruleConfirmedLines.map((l) => l.line_id));
      const rcLines = ruleConfirmedLines.map((l) => {
        const fp = l.fiscal_flags_preset as any;
        return `- [${l.line_id}] "${l.description.slice(0, 80)}" → deducib=${fp.deducibilita_pct ?? "?"}% IVA_detr=${fp.iva_detraibilita_pct ?? "?"}% (confermata da regola)`;
      });
      ruleConfirmedSection = `\n=== FISCALITA' CONFERMATA DA REGOLE ===
Per queste righe, la fiscalità è già stata confermata dall'utente tramite regola appresa:
${rcLines.join("\n")}
Verificale solo se noti un'incongruenza EVIDENTE. Non generare alert su queste.
===\n`;
    }

    // ─── Build prompt ──────────────────────────────────
    const lineEntries = lines.map((l, i) => {
      const ff = l.fiscal_flags;
      return `${i + 1}. [${l.line_id}] "${l.description}" tot=${l.total_price ?? "N/D"}
   → conto: ${l.account_code || "N/D"} (${l.account_name || "N/D"}) | cat: ${l.category_name || "N/D"} | conf: ${l.confidence} | source: ${l.source}
   → fiscale: deducib=${ff.deducibilita_pct}% IVA_detr=${ff.iva_detraibilita_pct}% ritenuta=${ff.ritenuta_acconto ? ff.ritenuta_acconto.aliquota + "%" : "no"} RC=${ff.reverse_charge} SP=${ff.split_payment} BS=${ff.bene_strumentale}${ff.note ? ` nota:"${ff.note}"` : ""}`;
    }).join("\n\n");

    const prompt = `Sei un REVISORE CONTABILE italiano senior. Devi controllare la classificazione fiscale di questa fattura.

CONTROPARTE: ${counterpartyInfo}
DIREZIONE: ${direction === "in" ? "PASSIVA (acquisto)" : "ATTIVA (vendita)"}
${kbSection}${preResolvedSection}${ruleConfirmedSection}

RIGHE CLASSIFICATE (da commercialista):
${lineEntries}

IL TUO COMPITO:
1. Per ogni riga, VERIFICA i fiscal_flags. Correggi se necessario.
2. Genera ALERT per l'utente quando serve una decisione umana.
3. Per le righe con decisioni già prese dall'utente o confermate da regole, RISPETTA le scelte (salvo incongruenze evidenti).

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

    // ─── Call Gemini ──────────────────────────────────
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

    // Apply pre-resolved fiscal overrides to reviews
    for (const [lineId, decs] of preResolvedFiscal) {
      let review = reviews.find((r) => r.line_id === lineId);
      if (!review) {
        // Create a review entry for this pre-resolved line
        const line = lines.find((l) => l.line_id === lineId);
        if (line) {
          review = {
            line_id: lineId,
            fiscal_flags_corrected: { ...line.fiscal_flags },
            issues: [],
            confidence_adjustment: 5,
          };
          reviews.push(review);
        }
      }
      if (review) {
        // Apply all fiscal overrides from user decisions
        for (const d of decs) {
          review.fiscal_flags_corrected = {
            ...review.fiscal_flags_corrected,
            ...d.fiscal_override,
          };
          if (!review.issues.some((i) => i.includes("decisione utente"))) {
            review.issues.push(`Decisione fiscale utente applicata (${d.chosen_option}, ${d.times_applied}x)`);
          }
          review.confidence_adjustment = Math.max(review.confidence_adjustment, 5);
        }
      }
    }

    // Parse alerts — filter out alerts for pre-resolved lines/types
    const alertStr = extractJsonSection(responseText, "---ALERTS---");
    let alerts: FiscalAlert[] = [];
    if (alertStr) {
      try {
        const rawAlerts: FiscalAlert[] = JSON.parse(alertStr);
        // Filter out alerts whose affected lines are all pre-resolved for that alert type
        alerts = rawAlerts.filter((a) => {
          const remainingLines = a.affected_lines.filter((lid) => {
            const preTypes = preResolvedAlertTypes.get(lid);
            if (preTypes && preTypes.has(a.type)) return false; // pre-resolved, skip
            return true;
          });
          a.affected_lines = remainingLines;
          return remainingLines.length > 0;
        });
      } catch { /* ignore */ }
    }

    await sql.end();

    return json({
      reviews,
      alerts,
      pre_resolved_count: preResolvedFiscal.size,
      prompt_length: prompt.length,
    });
  } catch (err) {
    await sql.end().catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
});
