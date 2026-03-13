// classify-v2-deterministic — Level 0 (classification_rules) + Level 1 (counterparty history)
// Returns instant suggestions without calling any AI — 0ms latency.
// Also attaches matched operation_keyword_groups to each line for downstream use.
//
// v2 (Fase 3): rules now include fiscal_flags, operation_group_code, subject_keywords.
// Matching uses Jaccard similarity >= 0.85 + operation group compatibility check.

import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
}

interface LineResult {
  line_id: string;
  category_id: string | null;
  account_id: string | null;
  article_id: string | null;
  phase_id: string | null;
  cost_center_allocations: { project_id: string; percentage: number }[] | null;
  fiscal_flags: Record<string, unknown> | null;
  confidence: number;
  reasoning: string;
  source: "rule" | "history";
  rule_id: string | null;
  matched_groups: string[]; // group_codes that matched this line
}

/* ─── Normalize description (mirrors classificationRulesService) ── */

function normalizeDescription(desc: string): string {
  return desc
    .toLowerCase()
    .replace(/[€$]/g, "")
    .replace(/\b\d+([.,]\d+)?\s*(eur|euro)?\b/gi, "")
    .replace(/\b\d+\b/g, "")
    .replace(/[,;:()[\]{}'"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ─── Jaccard word similarity ──────────── */

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  const intersection = [...a].filter((w) => b.has(w)).length;
  const union = new Set([...a, ...b]).size;
  return union > 0 ? intersection / union : 0;
}

/* ─── Extract best operation group for a description ── */

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

/* ─── Main ───────────────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const dbUrl = (Deno.env.get("SUPABASE_DB_URL") ?? "").trim();
  if (!dbUrl) return json({ error: "SUPABASE_DB_URL non configurato" }, 503);

  let body: {
    company_id?: string;
    invoice_id?: string;
    lines?: InputLine[];
    direction?: string;
    counterparty_vat_key?: string;
    counterparty_name?: string;
    contract_refs?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body JSON non valido" }, 400);
  }

  const companyId = body.company_id;
  const invoiceId = body.invoice_id;
  const lines = body.lines || [];
  const direction = body.direction || "in";
  const counterpartyVatKey = body.counterparty_vat_key || null;
  const contractRefs = body.contract_refs || [];

  if (!companyId) return json({ error: "company_id richiesto" }, 400);
  if (!invoiceId) return json({ error: "invoice_id richiesto" }, 400);
  if (lines.length === 0) return json({ error: "lines array vuoto" }, 400);

  const sql = postgres(dbUrl, { max: 1 });

  try {
    // ─── Load operation keyword groups (active only) ──────────
    const groups = await sql`
      SELECT group_code, group_name, macro_category, keywords
      FROM operation_keyword_groups
      WHERE active = true
      ORDER BY sort_order`;

    // Pre-process: for each line, find matching groups + best group code
    const lineGroups = new Map<string, string[]>();
    const lineBestGroup = new Map<string, string | null>();
    for (const line of lines) {
      const descLower = line.description.toLowerCase();
      const matched: string[] = [];
      for (const g of groups) {
        const kws = g.keywords as string[];
        if (kws.some((kw: string) => descLower.includes(kw.toLowerCase()))) {
          matched.push(g.group_code);
        }
      }
      lineGroups.set(line.line_id, matched);
      lineBestGroup.set(line.line_id, findBestOperationGroup(descLower, groups));
    }

    // ─── Level 0: Classification Rules ─────────────────────────
    // Try to match each line against stored classification_rules
    const resolvedLines: LineResult[] = [];
    const unresolvedLines: InputLine[] = [];

    // Resolve VAT key for rule lookup
    let vatKey: string | null = null;
    if (counterpartyVatKey) {
      vatKey = counterpartyVatKey.toUpperCase().replace(/^IT/i, "").replace(/[^A-Z0-9]/gi, "");
    }

    // Load matching rules for this counterparty (now including fiscal_flags, operation_group_code)
    const rules = vatKey
      ? await sql`
          SELECT id, description_pattern, direction, article_id, phase_id, category_id,
                 account_id, cost_center_allocations, confidence, fiscal_flags,
                 operation_group_code, subject_keywords, times_confirmed, contract_ref
          FROM classification_rules
          WHERE company_id = ${companyId}
            AND active = true
            AND (counterparty_vat_key = ${vatKey} OR counterparty_vat_key IS NULL)
            AND (direction = ${direction} OR direction IS NULL)
          ORDER BY
            CASE WHEN counterparty_vat_key IS NOT NULL THEN 0 ELSE 1 END,
            CASE WHEN contract_ref IS NOT NULL THEN 0 ELSE 1 END,
            times_confirmed DESC
          LIMIT 200`
      : await sql`
          SELECT id, description_pattern, direction, article_id, phase_id, category_id,
                 account_id, cost_center_allocations, confidence, fiscal_flags,
                 operation_group_code, subject_keywords, times_confirmed, contract_ref
          FROM classification_rules
          WHERE company_id = ${companyId}
            AND active = true
            AND counterparty_vat_key IS NULL
            AND (direction = ${direction} OR direction IS NULL)
          ORDER BY times_confirmed DESC
          LIMIT 100`;

    for (const line of lines) {
      const norm = normalizeDescription(line.description);
      const lineWordSet = new Set(norm.split(" ").filter((w) => w.length >= 2));
      const lineGroupCode = lineBestGroup.get(line.line_id) || null;
      let matched = false;

      for (const rule of rules) {
        const pattern = (rule.description_pattern || "").toLowerCase().trim();
        if (!pattern) continue;

        // ── CHECK 1: Operation group compatibility ──
        // If both rule and line have operation groups, they must match
        if (rule.operation_group_code && lineGroupCode) {
          if (rule.operation_group_code !== lineGroupCode) continue;
        }

        // ── CHECK 1.5: Contract reference compatibility ──
        // If the rule has a contract_ref, the invoice MUST have the same ref
        // If the rule has NO contract_ref, it matches any invoice (generic rule)
        if (rule.contract_ref) {
          if (!contractRefs.includes(rule.contract_ref)) continue;
        }

        // ── CHECK 2: Jaccard word similarity >= 0.85 ──
        const ruleWordSet = new Set(pattern.split(" ").filter((w: string) => w.length >= 2));
        const similarity = jaccardSimilarity(lineWordSet, ruleWordSet);

        if (similarity < 0.85) continue;

        // Match found!
        const hasFiscalFlags = rule.fiscal_flags && Object.keys(rule.fiscal_flags).length > 0;
        const lineGroupCodes = lineGroups.get(line.line_id) || [];

        resolvedLines.push({
          line_id: line.line_id,
          category_id: rule.category_id,
          account_id: rule.account_id,
          article_id: rule.article_id,
          phase_id: rule.phase_id,
          cost_center_allocations: (rule.cost_center_allocations as any) || null,
          fiscal_flags: rule.fiscal_flags || null,
          confidence: Math.min(rule.confidence || 80, 95), // cap at 95 for rules
          reasoning: hasFiscalFlags
            ? `Regola deterministica (pattern: "${pattern.slice(0, 60)}") con fiscalità confermata`
            : `Regola deterministica (pattern: "${pattern.slice(0, 60)}")`,
          source: "rule",
          rule_id: rule.id,
          matched_groups: lineGroupCodes,
        });
        matched = true;

        // Update times_applied
        sql`UPDATE classification_rules SET times_applied = times_applied + 1 WHERE id = ${rule.id}`.catch(() => {});
        break;
      }

      if (!matched) unresolvedLines.push(line);
    }

    // ─── Level 1: Counterparty History ─────────────────────────
    // For unresolved lines, check if this counterparty had similar descriptions confirmed before
    const stillUnresolved: InputLine[] = [];

    if (vatKey && unresolvedLines.length > 0) {
      // Load confirmed classification history for this counterparty
      const history = await sql`
        SELECT il.description, il.category_id, il.account_id,
               ila.article_id, ila.phase_id
        FROM invoice_lines il
        JOIN invoices i ON il.invoice_id = i.id
        LEFT JOIN invoice_line_articles ila ON ila.invoice_line_id = il.id AND ila.verified = true
        WHERE i.company_id = ${companyId}
          AND i.direction = ${direction}
          AND i.counterparty_id = (
            SELECT id FROM counterparties
            WHERE vat_key = ${vatKey} AND company_id = ${companyId}
            LIMIT 1
          )
          AND i.classification_status = 'confirmed'
          AND il.category_id IS NOT NULL
          AND il.account_id IS NOT NULL
        ORDER BY i.date DESC
        LIMIT 100`;

      // Build a map: normalized description → best match
      const historyMap = new Map<string, (typeof history)[0]>();
      for (const h of history) {
        const hNorm = normalizeDescription(h.description || "");
        if (hNorm && !historyMap.has(hNorm)) {
          historyMap.set(hNorm, h);
        }
      }

      for (const line of unresolvedLines) {
        const norm = normalizeDescription(line.description);
        const lineWordSet = new Set(norm.split(" ").filter((w) => w.length >= 2));
        const lineGroupCodes = lineGroups.get(line.line_id) || [];

        // Try exact match first
        let histMatch = historyMap.get(norm);

        // If no exact match, try Jaccard similarity >= 0.85
        if (!histMatch) {
          for (const [hNorm, hData] of historyMap) {
            const hWordSet = new Set(hNorm.split(" ").filter((w) => w.length >= 2));
            if (jaccardSimilarity(lineWordSet, hWordSet) >= 0.85) {
              histMatch = hData;
              break;
            }
          }
        }

        if (histMatch) {
          resolvedLines.push({
            line_id: line.line_id,
            category_id: histMatch.category_id,
            account_id: histMatch.account_id,
            article_id: histMatch.article_id || null,
            phase_id: histMatch.phase_id || null,
            cost_center_allocations: null,
            fiscal_flags: null, // History doesn't carry fiscal_flags — reviewer must check
            confidence: 75, // History-based: decent but not as strong as rules
            reasoning: `Pattern storico controparte usato come evidenza contestuale`,
            source: "history",
            rule_id: null,
            matched_groups: lineGroupCodes,
          });
        } else {
          stillUnresolved.push(line);
        }
      }
    } else {
      stillUnresolved.push(...unresolvedLines);
    }

    // Attach matched_groups to unresolved lines too
    const unresolvedWithGroups = stillUnresolved.map((l) => ({
      ...l,
      matched_groups: lineGroups.get(l.line_id) || [],
    }));

    await sql.end();

    return json({
      resolved: resolvedLines,
      unresolved: unresolvedWithGroups,
      stats: {
        total: lines.length,
        resolved_by_rules: resolvedLines.filter((r) => r.source === "rule").length,
        resolved_by_history: resolvedLines.filter((r) => r.source === "history").length,
        unresolved: unresolvedWithGroups.length,
      },
      _debug: {
        rules_checked: rules.length,
        history_checked: unresolvedLines.length,
        keyword_groups_loaded: groups.length,
        rules_matched: resolvedLines.filter((r) => r.source === "rule").length,
        history_matched: resolvedLines.filter((r) => r.source === "history").length,
      },
    });
  } catch (err) {
    await sql.end().catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
});
