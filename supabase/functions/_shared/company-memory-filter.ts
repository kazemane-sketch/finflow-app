import type { MemoryFact } from "./accounting-system-prompt.ts";

export interface CompanyMemoryQueryRow {
  fact_text: string;
  fact_type: string;
  source?: string | null;
  metadata?: Record<string, unknown> | string | null;
  source_primary_contract_ref?: string | null;
  source_contract_refs?: unknown;
  similarity?: number;
}

function parseMetadata(input: CompanyMemoryQueryRow["metadata"]): Record<string, unknown> {
  if (!input) return {};
  if (typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore invalid legacy metadata
    }
  }
  return {};
}

function toStringArray(input: unknown): string[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input
      .map((value) => (typeof value === "string" ? value : String(value ?? "")))
      .map((value) => value.trim())
      .filter(Boolean);
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        return toStringArray(parsed);
      } catch {
        // fall through to singleton
      }
    }
    return [trimmed];
  }
  return [];
}

function normalizeText(value: string | null | undefined): string {
  return (value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeContractRef(value: string | null | undefined): string {
  return (value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function extractFactLineDescription(row: CompanyMemoryQueryRow): string | null {
  const metadata = parseMetadata(row.metadata);
  const fromMetadata = metadata.line_description;
  if (typeof fromMetadata === "string" && fromMetadata.trim()) return fromMetadata.trim();

  const match = row.fact_text.match(/riga ['"]([^'"]+)['"]/i);
  return match?.[1]?.trim() || null;
}

function isLeasingText(value: string | null | undefined): boolean {
  return /(leasing|locazione finanziaria|canone leasing|canone locazione finanziaria)/i.test(value || "");
}

function extractFactContractRefs(row: CompanyMemoryQueryRow): string[] {
  const metadata = parseMetadata(row.metadata);
  const refs = new Set<string>();

  const pushRefs = (values: unknown) => {
    for (const ref of toStringArray(values)) {
      const normalized = normalizeContractRef(ref);
      if (normalized) refs.add(normalized);
    }
  };

  pushRefs(metadata.contract_ref);
  pushRefs(metadata.contract_refs);
  pushRefs(row.source_primary_contract_ref);
  pushRefs(row.source_contract_refs);

  return [...refs];
}

export function filterCompanyMemoryForInvoiceClassification(
  rows: CompanyMemoryQueryRow[],
  lineDescriptions: string[],
  invoiceContractRefs: string[],
): MemoryFact[] {
  const currentLineDescriptions = new Set(
    lineDescriptions
      .map((line) => normalizeText(line))
      .filter(Boolean),
  );
  const currentContractRefs = new Set(
    invoiceContractRefs
      .map((ref) => normalizeContractRef(ref))
      .filter(Boolean),
  );

  return rows
    .filter((row) => {
      if ((row.source || "").toLowerCase() === "reconciliation") return false;

      const factLineDescription = extractFactLineDescription(row);
      const leasingLike = isLeasingText(row.fact_text) || isLeasingText(factLineDescription);
      if (!leasingLike) return true;

      if (!factLineDescription) return false;
      if (!currentLineDescriptions.has(normalizeText(factLineDescription))) return false;

      const factContractRefs = extractFactContractRefs(row);
      if (currentContractRefs.size === 0 || factContractRefs.length === 0) return false;

      return factContractRefs.some((ref) => currentContractRefs.has(ref));
    })
    .map((row) => ({
      fact_text: row.fact_text,
      fact_type: row.fact_type,
      similarity: row.similarity,
    }));
}

export function getInvoiceContractRefs(
  primaryContractRef?: string | null,
  contractRefs?: unknown,
): string[] {
  const refs = new Set<string>();
  for (const ref of toStringArray(primaryContractRef)) {
    const normalized = ref.trim();
    if (normalized) refs.add(normalized);
  }
  for (const ref of toStringArray(contractRefs)) {
    const normalized = ref.trim();
    if (normalized) refs.add(normalized);
  }
  return [...refs];
}
