// src/lib/coaTemplateService.ts — Template-based chart of accounts for onboarding
import { supabase } from '@/integrations/supabase/client'
import type { CoaSection } from '@/lib/classificationService'

// ─── Types ────────────────────────────────────────────────

export type CoaSector = 'commercio' | 'servizi' | 'manifattura_costruzioni'

export interface SectorMeta {
  sector: CoaSector
  label: string
  icon: string
  description: string
  accountCount: number
}

export interface TemplateAccount {
  code: string
  name: string
  section: CoaSection
  parent_code: string | null
  is_header: boolean
  notes: string | null
}

// ─── Static metadata ─────────────────────────────────────

const SECTOR_META: Record<CoaSector, Omit<SectorMeta, 'accountCount'>> = {
  commercio: {
    sector: 'commercio',
    label: 'Commercio',
    icon: '🏪',
    description: 'Commercio al dettaglio e ingrosso',
  },
  servizi: {
    sector: 'servizi',
    label: 'Servizi',
    icon: '💼',
    description: 'Servizi professionali, consulenza, IT',
  },
  manifattura_costruzioni: {
    sector: 'manifattura_costruzioni',
    label: 'Manifattura / Costruzioni',
    icon: '🏭',
    description: 'Produzione, edilizia, cave, trasporti',
  },
}

// ─── Helpers ─────────────────────────────────────────────

/** Derive hierarchy level from code length (matches existing chart_of_accounts pattern) */
export function deriveLevel(code: string): number {
  const len = code.length
  if (len <= 2) return 1
  if (len <= 5) return 2
  return 3
}

// ─── API ─────────────────────────────────────────────────

/**
 * Load sector metadata with actual account counts from coa_templates.
 * Returns all 3 sectors with counts (0 if templates not yet seeded).
 */
export async function loadTemplateSectors(): Promise<SectorMeta[]> {
  const { data, error } = await supabase
    .from('coa_templates')
    .select('sector')

  if (error) throw error

  // Count per sector
  const counts: Record<string, number> = {}
  for (const row of data || []) {
    counts[row.sector] = (counts[row.sector] || 0) + 1
  }

  return (['commercio', 'servizi', 'manifattura_costruzioni'] as CoaSector[]).map(s => ({
    ...SECTOR_META[s],
    accountCount: counts[s] || 0,
  }))
}

/**
 * Load all template accounts for a given sector.
 */
export async function loadTemplateAccounts(sector: CoaSector): Promise<TemplateAccount[]> {
  const { data, error } = await supabase
    .from('coa_templates')
    .select('code, name, section, parent_code, is_header, notes')
    .eq('sector', sector)
    .order('code')

  if (error) throw error
  return (data || []) as TemplateAccount[]
}

/**
 * Apply a sector template to a company's chart of accounts.
 * Uses ON CONFLICT DO NOTHING so existing accounts are preserved.
 * Returns the number of template accounts (not necessarily new inserts).
 */
export async function applyTemplate(companyId: string, sector: CoaSector): Promise<number> {
  // 1. Load template for sector
  const templates = await loadTemplateAccounts(sector)
  if (!templates.length) throw new Error('Nessun template trovato per il settore selezionato')

  // 2. Map to chart_of_accounts rows with derived level
  const rows = templates.map((t, i) => ({
    company_id: companyId,
    code: t.code,
    name: t.name,
    section: t.section,
    parent_code: t.parent_code,
    level: deriveLevel(t.code),
    is_header: t.is_header,
    active: true,
    sort_order: (i + 1) * 10,
  }))

  // 3. Upsert with ignoreDuplicates (ON CONFLICT DO NOTHING)
  const { error } = await supabase
    .from('chart_of_accounts')
    .upsert(rows, { onConflict: 'company_id,code', ignoreDuplicates: true })

  if (error) throw error

  return rows.length
}
