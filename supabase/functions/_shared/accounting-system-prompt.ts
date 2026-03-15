/**
 * System prompt condiviso per tutte le AI di FinFlow.
 * Ogni edge function che chiama un LLM (Sonnet, Haiku, Gemini) importa questo modulo.
 * Modificare QUI per aggiornare il comportamento di tutte le AI simultaneamente.
 *
 * NOTE (v2 — Commercialista Brain):
 * I codici conto specifici e le regole settoriali NON sono più qui.
 * Risiedono in company_memory e vengono iniettati via getCompanyMemoryBlock().
 * Qui restano SOLO i principi generici della contabilità italiana.
 */

export interface CompanyContext {
  company_name: string;
  sector: string;        // 'commercio' | 'servizi' | 'manifattura_costruzioni'
  ateco_code?: string;
  vat_number?: string;
}

export interface MemoryFact {
  fact_text: string;
  fact_type: string;
  similarity?: number;
}

/**
 * Restituisce il system prompt base contabile (principi generici).
 * I codici conto specifici dell'azienda vengono da company_memory.
 */
export function getAccountingSystemPrompt(company?: CompanyContext): string {
  return `Sei un commercialista italiano senior con 20 anni di esperienza in PMI. Conosci la normativa italiana vigente (OIC, TUIR, DPR 633/72, Codice Civile).

Hai a disposizione tool per cercare parametri fiscali, conti, storico classificazioni, e knowledge base normativa. Usali quando hai bisogno di dati specifici — non fare affidamento sulla memoria per percentuali, soglie o casistiche particolari.

Nel dubbio, scegli l'approccio più conservativo e segnala l'incertezza.
${company ? `\nAZIENDA: ${company.company_name}${company.ateco_code ? ` (ATECO ${company.ateco_code})` : ''}${company.vat_number ? ` P.IVA ${company.vat_number}` : ''}` : ''}`.trim();
}

/**
 * Formatta i fatti della company_memory per l'iniezione nel prompt AI.
 * I fatti vengono raggruppati per tipo per leggibilità.
 */
export function getCompanyMemoryBlock(memoryFacts: MemoryFact[]): string {
  if (!memoryFacts || memoryFacts.length === 0) return '';

  // Group facts by type
  const grouped: Record<string, string[]> = {};
  for (const f of memoryFacts) {
    const key = f.fact_type || 'general';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(f.fact_text);
  }

  const typeLabels: Record<string, string> = {
    counterparty_pattern: 'Pattern controparte',
    account_mapping: 'Mappature conti specifiche',
    user_correction: 'Correzioni utente',
    fiscal_rule: 'Regole fiscali aziendali',
    general: 'Regole generali',
  };

  const sections: string[] = [];
  for (const [type, facts] of Object.entries(grouped)) {
    const label = typeLabels[type] || type;
    sections.push(`[${label}]\n${facts.map(f => `- ${f}`).join('\n')}`);
  }

  return `\n\nCONOSCENZA AZIENDALE (memoria contestuale, non verdetto automatico):
Usa questi fatti come evidenze contestuali e pattern aziendali. Nel reasoning chiamali "memoria aziendale" o "pattern aziendale", NON "storico confermato". Se i fatti sono parziali o non equivalenti, trattali come indizi da pesare e non come prova conclusiva.
${sections.join('\n\n')}`;
}

/**
 * Carica le user_instructions per l'azienda e le formatta per il prompt.
 */
export async function getUserInstructionsBlock(
  sql: any,
  companyId: string,
): Promise<string> {
  const instructions = await sql`
    SELECT instruction, scope,
           CASE WHEN scope_ref IS NOT NULL
                THEN (SELECT name FROM counterparties WHERE id = scope_ref::uuid LIMIT 1)
               ELSE NULL END as counterparty_name
    FROM user_instructions
    WHERE company_id = ${companyId} AND active = true
    ORDER BY created_at DESC
    LIMIT 50
  `;

  if (instructions.length === 0) return '';

  return `\n\nISTRUZIONI SPECIFICHE DELL'UTENTE (hanno priorità sulle regole generali):
${instructions.map((i: any) =>
    `- ${i.counterparty_name ? `[${i.counterparty_name}] ` : ''}${i.instruction}`
  ).join('\n')}`;
}
