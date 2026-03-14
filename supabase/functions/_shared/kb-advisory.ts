import postgres from "npm:postgres@3.4.5";

type SqlClient = ReturnType<typeof postgres>;
type AdvisoryAudience = "commercialista" | "revisore" | "both";
type RetrievalMode = "commercialista" | "revisore" | "consulente";

export interface AdvisoryNote {
  id: string;
  knowledge_kind: "advisory_note" | "numeric_fact";
  title: string;
  domain: string;
  audience: AdvisoryAudience;
  short_answer: string;
  question: string | null;
  applies_when: string[];
  not_when: string[];
  missing_info: string[];
  numeric_facts: Record<string, number | string>;
  source_refs: string[];
  source_document_title: string | null;
  source_chunk_ids: string[];
  similarity: number;
}

export interface AdvisoryChunk {
  id: string;
  document_id: string;
  doc_title: string | null;
  authority: string | null;
  source_type: string | null;
  section_title: string | null;
  article_reference: string | null;
  content: string;
  similarity: number;
}

interface AdvisoryNoteRow {
  id: string;
  knowledge_kind: "advisory_note" | "numeric_fact" | "legacy_rule";
  domain: string;
  audience: AdvisoryAudience;
  title: string;
  content: string;
  summary_structured?: Record<string, unknown> | string | null;
  applicability?: Record<string, unknown> | string | null;
  normativa_ref?: string[] | null;
  source_chunk_ids?: string[] | null;
  similarity?: number | null;
  source_document_title?: string | null;
  source_authority?: string | null;
  source_type?: string | null;
  source_applies_to_ateco_prefixes?: string[] | null;
  source_applies_to_operations?: string[] | null;
  source_applies_to_counterparty?: string[] | null;
  source_amount_threshold_min?: number | null;
  source_amount_threshold_max?: number | null;
}

interface AdvisoryChunkRow {
  id: string;
  document_id: string;
  content: string;
  section_title?: string | null;
  article_reference?: string | null;
  similarity?: number | null;
  doc_title?: string | null;
  authority?: string | null;
  source_type?: string | null;
  applies_to_ateco_prefixes?: string[] | null;
  applies_to_operations?: string[] | null;
  applies_to_counterparty?: string[] | null;
  amount_threshold_min?: number | null;
  amount_threshold_max?: number | null;
}

interface AdvisoryContextArgs {
  companyId: string;
  audience: AdvisoryAudience;
  queryVecLiteral: string;
  companyAteco?: string | null;
  counterpartyName?: string | null;
  counterpartyTags?: string[];
  operationTags?: string[];
  invoiceAmount?: number | null;
  noteLimit?: number;
  chunkLimit?: number;
}

interface ConsultKbArgs {
  mode: RetrievalMode;
  lineDescriptions: string[];
  exactMatchCount?: number;
  totalLines?: number;
  confidences?: number[];
  fiscalNotes?: string[];
  alertContext?: string | null;
}

const KB_HINT_RE =
  /\b(leasing|locazione finanziaria|canone|mutuo|polizza|assicur|bancar|incasso|commission|interess|iva|detraibil|deducibil|ritenut|reverse|split|autovett|autocar|veicolo|automez|escavator|pala|bulldozer|telefono|ristor|omagg|rappresentanza|strumentale)\b/i;

function clip(value: string | null | undefined, max: number): string {
  if (!value) return "";
  return value.length > max ? value.slice(0, max) : value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore malformed legacy json
    }
  }
  return {};
}

function toStringArray(input: unknown): string[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.map((value) => String(value || "").trim()).filter(Boolean);
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        return toStringArray(JSON.parse(trimmed));
      } catch {
        return [trimmed];
      }
    }
    return [trimmed];
  }
  return [];
}

function normalizeToken(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function normalizeCounterpartyTags(tags: string[]): string[] {
  return tags.map(normalizeToken).filter(Boolean);
}

function hasIntersection(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const right = new Set(b.map(normalizeToken));
  return a.some((value) => right.has(normalizeToken(value)));
}

function parseSummaryStructured(input: AdvisoryNoteRow["summary_structured"]): Record<string, unknown> {
  return asRecord(input);
}

function extractNumericFacts(summary: Record<string, unknown>): Record<string, number | string> {
  const raw = summary.numeric_facts;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter(([, value]) => ["string", "number"].includes(typeof value)),
  ) as Record<string, number | string>;
}

function matchesAmountThreshold(
  amount: number | null | undefined,
  minValue: number | null | undefined,
  maxValue: number | null | undefined,
): boolean {
  if (!Number.isFinite(Number(amount))) return true;
  const numericAmount = Number(amount);
  if (Number.isFinite(Number(minValue)) && numericAmount < Number(minValue)) return false;
  if (Number.isFinite(Number(maxValue)) && numericAmount > Number(maxValue)) return false;
  return true;
}

function noteMatchesFilters(row: AdvisoryNoteRow, args: AdvisoryContextArgs): boolean {
  const companyAteco = (args.companyAteco || "").trim();
  const atecoPrefixes = toStringArray(row.source_applies_to_ateco_prefixes);
  if (companyAteco && atecoPrefixes.length > 0) {
    const matchesAteco = atecoPrefixes.some((prefix) => companyAteco.startsWith(prefix));
    if (!matchesAteco) return false;
  }

  const operationTags = args.operationTags || [];
  const noteApplicability = asRecord(row.applicability);
  const noteOperations = toStringArray(noteApplicability.applies_to_operations);
  const sourceOperations = toStringArray(row.source_applies_to_operations);
  const effectiveOperations = noteOperations.length > 0 ? noteOperations : sourceOperations;
  if (effectiveOperations.length > 0 && operationTags.length > 0 && !hasIntersection(effectiveOperations, operationTags)) {
    return false;
  }

  const counterpartyTags = normalizeCounterpartyTags(args.counterpartyTags || []);
  const noteCounterparty = toStringArray(noteApplicability.applies_to_counterparty);
  const sourceCounterparty = toStringArray(row.source_applies_to_counterparty);
  const effectiveCounterparty = noteCounterparty.length > 0 ? noteCounterparty : sourceCounterparty;
  if (effectiveCounterparty.length > 0 && counterpartyTags.length > 0 && !hasIntersection(effectiveCounterparty, counterpartyTags)) {
    return false;
  }

  const noteMin = Number(noteApplicability.amount_threshold_min ?? row.source_amount_threshold_min ?? NaN);
  const noteMax = Number(noteApplicability.amount_threshold_max ?? row.source_amount_threshold_max ?? NaN);
  if (!matchesAmountThreshold(args.invoiceAmount, Number.isFinite(noteMin) ? noteMin : null, Number.isFinite(noteMax) ? noteMax : null)) {
    return false;
  }

  return true;
}

function chunkMatchesFilters(row: AdvisoryChunkRow, args: AdvisoryContextArgs): boolean {
  const companyAteco = (args.companyAteco || "").trim();
  const atecoPrefixes = toStringArray(row.applies_to_ateco_prefixes);
  if (companyAteco && atecoPrefixes.length > 0) {
    const matchesAteco = atecoPrefixes.some((prefix) => companyAteco.startsWith(prefix));
    if (!matchesAteco) return false;
  }

  if (args.operationTags?.length && toStringArray(row.applies_to_operations).length > 0) {
    if (!hasIntersection(toStringArray(row.applies_to_operations), args.operationTags)) return false;
  }

  if (args.counterpartyTags?.length && toStringArray(row.applies_to_counterparty).length > 0) {
    if (!hasIntersection(toStringArray(row.applies_to_counterparty), args.counterpartyTags)) return false;
  }

  if (!matchesAmountThreshold(args.invoiceAmount, row.amount_threshold_min, row.amount_threshold_max)) {
    return false;
  }

  return true;
}

export function shouldConsultKbAdvisory(args: ConsultKbArgs): boolean {
  const joined = [
    ...args.lineDescriptions,
    ...(args.fiscalNotes || []),
    String(args.alertContext || ""),
  ].join(" | ");
  const hasSensitiveSignals = KB_HINT_RE.test(joined);
  const exactMatchCount = args.exactMatchCount ?? 0;
  const totalLines = args.totalLines ?? args.lineDescriptions.length;

  if (args.mode === "consulente") {
    return hasSensitiveSignals || Boolean(String(args.alertContext || "").trim());
  }

  if (args.mode === "commercialista") {
    return hasSensitiveSignals && exactMatchCount < totalLines;
  }

  const hasLowConfidence = (args.confidences || []).some((value) => Number(value) < 85);
  const hasExistingDoubt = (args.fiscalNotes || []).some((value) => /dubb|verific|incert|chiar/i.test(value || ""));
  return hasSensitiveSignals && (hasLowConfidence || hasExistingDoubt || exactMatchCount < totalLines);
}

export function inferKbOperationTags(lineDescriptions: string[]): string[] {
  const joined = lineDescriptions.join(" ").toLowerCase();
  const tags = new Set<string>();

  if (/\bleasing|locazione finanziaria|maxicanone|canone\b/.test(joined)) tags.add("leasing");
  if (/\bnoleggio|rent\b/.test(joined)) tags.add("noleggio");
  if (/\bassicur|polizza\b/.test(joined)) tags.add("assicurazione");
  if (/\bbanca|incasso|commission|interess\b/.test(joined)) tags.add("banca");
  if (/\bautofatt|td16|td17|td18|td19|reverse\b/.test(joined)) tags.add("autofattura");
  if (/\bserviz/i.test(joined)) tags.add("servizi");
  if (/\bautovett|auto\b/.test(joined)) tags.add("veicoli");

  return [...tags];
}

export function inferKbCounterpartyTags(name: string, legalType?: string | null, businessSector?: string | null): string[] {
  const joined = [name, legalType || "", businessSector || ""].join(" ").toLowerCase();
  const tags = new Set<string>();

  if (/\bbanca|credito|istituto monetario\b/.test(joined)) tags.add("banca");
  if (/\bassicur/.test(joined)) tags.add("assicurazione");
  if (/\bprofession|studio|avvocat|ingegner|geometr|notaio|commercialista\b/.test(joined)) tags.add("professionista");
  if (/\bpubblica amministrazione|comune|regione|ministro|ministero|agenzia\b/.test(joined)) tags.add("pa");
  if (/\bforfett/.test(joined)) tags.add("forfettario");

  return [...tags];
}

export async function loadKbAdvisoryContext(sql: SqlClient, args: AdvisoryContextArgs): Promise<{
  notes: AdvisoryNote[];
  chunks: AdvisoryChunk[];
}> {
  const noteLimit = Math.max(0, Math.min(args.noteLimit ?? 2, 5));
  const chunkLimit = Math.max(0, Math.min(args.chunkLimit ?? 2, 6));

  const [rawNotes, rawChunks] = await Promise.all([
    noteLimit > 0
      ? sql.unsafe(
          `SELECT
             kb.id,
             kb.knowledge_kind,
             kb.domain,
             kb.audience,
             kb.title,
             kb.content,
             kb.summary_structured,
             kb.applicability,
             kb.normativa_ref,
             kb.source_chunk_ids,
             kd.title AS source_document_title,
             kd.authority AS source_authority,
             kd.source_type,
             kd.applies_to_ateco_prefixes AS source_applies_to_ateco_prefixes,
             kd.applies_to_operations AS source_applies_to_operations,
             kd.applies_to_counterparty AS source_applies_to_counterparty,
             kd.amount_threshold_min AS source_amount_threshold_min,
             kd.amount_threshold_max AS source_amount_threshold_max,
             (1 - (kb.embedding <=> $1::halfvec(3072)))::float AS similarity
           FROM knowledge_base kb
           LEFT JOIN kb_documents kd ON kd.id = kb.source_document_id
           WHERE kb.active = true
             AND kb.status = 'approved'
             AND kb.embedding IS NOT NULL
             AND kb.knowledge_kind IN ('advisory_note', 'numeric_fact')
             AND cardinality(kb.source_chunk_ids) > 0
             AND (kb.audience = $2 OR kb.audience = 'both')
             AND kb.effective_from <= CURRENT_DATE
             AND kb.effective_to >= CURRENT_DATE
           ORDER BY kb.embedding <=> $1::halfvec(3072)
           LIMIT 24`,
          [args.queryVecLiteral, args.audience],
        )
      : Promise.resolve([]),
    chunkLimit > 0
      ? sql.unsafe(
          `SELECT
             kc.id,
             kc.document_id,
             kc.content,
             kc.section_title,
             kc.article_reference,
             kd.title AS doc_title,
             kd.authority,
             kd.source_type,
             kd.applies_to_ateco_prefixes,
             kd.applies_to_operations,
             kd.applies_to_counterparty,
             kd.amount_threshold_min,
             kd.amount_threshold_max,
             (1 - (kc.embedding <=> $1::halfvec(3072)))::float AS similarity
           FROM kb_chunks kc
           JOIN kb_documents kd ON kd.id = kc.document_id
           WHERE (kc.company_id IS NULL OR kc.company_id = $2)
             AND kd.status = 'ready'
             AND kd.active = true
           ORDER BY kc.embedding <=> $1::halfvec(3072)
           LIMIT 24`,
          [args.queryVecLiteral, args.companyId],
        )
      : Promise.resolve([]),
  ]);

  const notes = (rawNotes as AdvisoryNoteRow[])
    .filter((row) => Number(row.similarity || 0) >= 0.45)
    .filter((row) => noteMatchesFilters(row, args))
    .slice(0, noteLimit)
    .map((row) => {
      const summary = parseSummaryStructured(row.summary_structured);
      const shortAnswer = clip(
        String(summary.short_answer || row.content || row.title || "").trim(),
        500,
      );
      return {
        id: row.id,
        knowledge_kind: row.knowledge_kind,
        title: row.title,
        domain: row.domain,
        audience: row.audience,
        short_answer: shortAnswer,
        question: clip(String(summary.question || "").trim(), 240) || null,
        applies_when: toStringArray(summary.applies_when).slice(0, 4),
        not_when: toStringArray(summary.not_when).slice(0, 4),
        missing_info: toStringArray(summary.missing_info).slice(0, 4),
        numeric_facts: extractNumericFacts(summary),
        source_refs: Array.from(
          new Set([
            ...toStringArray(summary.source_refs),
            ...toStringArray(row.normativa_ref),
          ]),
        ).slice(0, 6),
        source_document_title: row.source_document_title || null,
        source_chunk_ids: toStringArray(row.source_chunk_ids),
        similarity: Number(row.similarity || 0),
      } satisfies AdvisoryNote;
    });

  const chunks = (rawChunks as AdvisoryChunkRow[])
    .filter((row) => Number(row.similarity || 0) >= 0.45)
    .filter((row) => chunkMatchesFilters(row, args))
    .slice(0, chunkLimit)
    .map((row) => ({
      id: row.id,
      document_id: row.document_id,
      doc_title: row.doc_title || null,
      authority: row.authority || null,
      source_type: row.source_type || null,
      section_title: row.section_title || null,
      article_reference: row.article_reference || null,
      content: clip(String(row.content || ""), 1400),
      similarity: Number(row.similarity || 0),
    }) satisfies AdvisoryChunk);

  return { notes, chunks };
}

export function formatKbAdvisoryNotesContext(notes: AdvisoryNote[]): string {
  return notes
    .map((note, index) => {
      const parts = [
        `KB-NOTE-${index + 1}`,
        `title=${note.title}`,
        note.question ? `question="${clip(note.question, 180)}"` : null,
        `answer="${clip(note.short_answer, 320)}"`,
        note.applies_when.length ? `applies_when=${clip(note.applies_when.join("; "), 220)}` : null,
        note.not_when.length ? `not_when=${clip(note.not_when.join("; "), 220)}` : null,
        note.missing_info.length ? `missing_info=${clip(note.missing_info.join("; "), 220)}` : null,
        note.source_refs.length ? `refs=${clip(note.source_refs.join(", "), 180)}` : null,
        note.source_document_title ? `doc=${clip(note.source_document_title, 120)}` : null,
        `sim=${note.similarity.toFixed(2)}`,
      ].filter(Boolean);
      return `- ${parts.join(" | ")}`;
    })
    .join("\n");
}

export function formatKbSourceChunksContext(chunks: AdvisoryChunk[]): string {
  return chunks
    .map((chunk, index) => {
      const parts = [
        `KB-CHUNK-${index + 1}`,
        `doc=${clip(chunk.doc_title || "Documento", 120)}`,
        chunk.section_title ? `section=${clip(chunk.section_title, 120)}` : null,
        chunk.article_reference ? `ref=${clip(chunk.article_reference, 80)}` : null,
        `sim=${chunk.similarity.toFixed(2)}`,
        `excerpt="${clip(chunk.content, 500)}"`,
      ].filter(Boolean);
      return `- ${parts.join(" | ")}`;
    })
    .join("\n");
}
