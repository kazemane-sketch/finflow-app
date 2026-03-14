// supabase/functions/admin-embed-kb-rule/index.ts
// Generates Gemini embedding for a knowledge_base note/rule and saves it
// Called after create/update from the admin panel

import postgres from "npm:postgres@3.4.5";

/* ─── CORS ───────────────────────────────── */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EMBEDDING_MODEL = "gemini-embedding-001";
const EXPECTED_DIMS = 3072;

/* ─── Helpers ────────────────────────────── */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/* ─── Main handler ───────────────────────── */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const dbUrl = (Deno.env.get("SUPABASE_DB_URL") ?? "").trim();
  if (!dbUrl) return json({ error: "SUPABASE_DB_URL not configured" }, 500);

  // Verify admin
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "Non autorizzato" }, 401);

  let userId: string | null = null;
  let jwtRole: string | null = null;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    userId = payload.sub || null;
    jwtRole = payload.role || null;
    if (!userId && jwtRole !== "service_role") throw new Error("no sub");
  } catch {
    return json({ error: "Token JWT invalido" }, 401);
  }

  const body = await req.json().catch(() => ({})) as { rule_id?: string; action?: string };
  const ruleId = body.rule_id;

  const sql = postgres(dbUrl, { max: 2 });

  try {
    if (jwtRole !== "service_role") {
      const [admin] = await sql`
        SELECT 1 FROM platform_admins WHERE user_id = ${userId}
      `;
      if (!admin) {
        await sql.end();
        return json({ error: "Non sei un platform admin" }, 403);
      }
    }

    if (body.action === "apply_kb_vnext_migration") {
      await sql`
        ALTER TABLE public.knowledge_base
          ADD COLUMN IF NOT EXISTS knowledge_kind text
      `;
      await sql`
        UPDATE public.knowledge_base
        SET knowledge_kind = 'legacy_rule'
        WHERE knowledge_kind IS NULL
      `;
      await sql`
        ALTER TABLE public.knowledge_base
          ALTER COLUMN knowledge_kind SET DEFAULT 'advisory_note'
      `;
      await sql`
        ALTER TABLE public.knowledge_base
          ALTER COLUMN knowledge_kind SET NOT NULL
      `;
      await sql`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'knowledge_base_knowledge_kind_check'
          ) THEN
            ALTER TABLE public.knowledge_base
              ADD CONSTRAINT knowledge_base_knowledge_kind_check
              CHECK (knowledge_kind IN ('advisory_note', 'numeric_fact', 'legacy_rule'));
          END IF;
        END $$;
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_knowledge_base_knowledge_kind
          ON public.knowledge_base (knowledge_kind)
      `;
      await sql.end();
      return json({ ok: true, migration_applied: "060_kb_vnext_advisory" });
    }

    if (!ruleId) return json({ error: "rule_id è obbligatorio" }, 400);
    const geminiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
    if (!geminiKey) return json({ error: "GEMINI_API_KEY not configured" }, 500);

    // Read the rule
    const [rule] = await sql`
      SELECT id, title, content, trigger_keywords, domain, normativa_ref,
             summary_structured, applicability, source_chunk_ids, knowledge_kind
      FROM knowledge_base WHERE id = ${ruleId}
    `;
    if (!rule) {
      await sql.end();
      return json({ error: "Regola non trovata" }, 404);
    }

    const summary = rule.summary_structured && typeof rule.summary_structured === "object"
      ? rule.summary_structured as Record<string, unknown>
      : {};
    const applicability = rule.applicability && typeof rule.applicability === "object"
      ? rule.applicability as Record<string, unknown>
      : {};

    // Build text to embed
    const parts: string[] = [
      rule.title,
      rule.content,
      `Knowledge kind: ${rule.knowledge_kind || "advisory_note"}`,
    ];
    if (rule.domain) parts.push(`Dominio: ${rule.domain}`);
    if (summary.question) parts.push(`Question: ${summary.question}`);
    if (summary.short_answer) parts.push(`Answer: ${summary.short_answer}`);
    if (Array.isArray(summary.applies_when) && summary.applies_when.length > 0) {
      parts.push(`Applies when: ${summary.applies_when.join(", ")}`);
    }
    if (Array.isArray(summary.not_when) && summary.not_when.length > 0) {
      parts.push(`Not when: ${summary.not_when.join(", ")}`);
    }
    if (Array.isArray(summary.missing_info) && summary.missing_info.length > 0) {
      parts.push(`Missing info: ${summary.missing_info.join(", ")}`);
    }
    if (rule.normativa_ref?.length) {
      parts.push(`Riferimenti: ${rule.normativa_ref.join(", ")}`);
    }
    if (Array.isArray(summary.source_refs) && summary.source_refs.length > 0) {
      parts.push(`Source refs: ${summary.source_refs.join(", ")}`);
    }
    if (applicability && Object.keys(applicability).length > 0) {
      parts.push(`Applicability: ${JSON.stringify(applicability)}`);
    }
    if (rule.source_chunk_ids?.length) {
      parts.push(`Source chunks: ${rule.source_chunk_ids.join(", ")}`);
    }
    if (rule.trigger_keywords?.length) {
      parts.push(`Keywords: ${rule.trigger_keywords.join(", ")}`);
    }
    const textToEmbed = parts.join(". ");

    // Call Gemini Embedding
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${geminiKey}`;
    const embRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text: textToEmbed }] },
        taskType: "RETRIEVAL_DOCUMENT",
        outputDimensionality: EXPECTED_DIMS,
      }),
    });

    const embData = await embRes.json();
    if (!embRes.ok) {
      const msg = embData?.error?.message || `HTTP ${embRes.status}`;
      throw new Error(`Gemini embedding error: ${msg}`);
    }

    const values = embData?.embedding?.values;
    if (!Array.isArray(values) || values.length !== EXPECTED_DIMS) {
      throw new Error(
        `Expected ${EXPECTED_DIMS} dims, got ${values?.length ?? 0}`,
      );
    }

    // Save embedding
    const vecLiteral = `[${values.map((v: number) => v.toFixed(8)).join(",")}]`;
    await sql.unsafe(
      `UPDATE knowledge_base SET embedding = $1::halfvec(3072), updated_at = now() WHERE id = $2`,
      [vecLiteral, ruleId],
    );

    await sql.end();
    return json({ ok: true, rule_id: ruleId, text_length: textToEmbed.length });
  } catch (err) {
    await sql.end().catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
});
