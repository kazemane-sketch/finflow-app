// src/lib/classificationService.ts — CRUD for Categories, Projects, Chart of Accounts
// and invoice-level / line-level classification assignments.
import { supabase } from '@/integrations/supabase/client';
import { createClassificationExample } from '@/lib/learningService';
import { triggerEntityEmbedding } from '@/lib/companyMemoryService';

// ─── Types ────────────────────────────────────────────────

export type CategoryType = 'revenue' | 'expense' | 'both';
export type ProjectStatus = 'active' | 'completed' | 'suspended';
export type CoaSection =
  | 'assets' | 'liabilities' | 'equity' | 'revenue'
  | 'cost_production' | 'cost_personnel' | 'depreciation'
  | 'other_costs' | 'financial' | 'extraordinary';

export interface Category {
  id: string;
  company_id: string;
  name: string;
  type: CategoryType;
  color: string;
  icon: string | null;
  description: string | null;
  parent_id: string | null;
  sort_order: number;
  active: boolean;
  created_at: string;
}

export interface CategoryCreate {
  name: string;
  type: CategoryType;
  color: string;
  icon?: string | null;
  description?: string | null;
  parent_id?: string | null;
}

export interface Project {
  id: string;
  company_id: string;
  code: string;
  name: string;
  description: string | null;
  color: string;
  status: ProjectStatus;
  start_date: string | null;
  end_date: string | null;
  budget: number | null;
  sort_order: number;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectCreate {
  code: string;
  name: string;
  description?: string | null;
  color?: string;
  status?: ProjectStatus;
  start_date?: string | null;
  end_date?: string | null;
  budget?: number | null;
  parent_id?: string | null;
}

export interface ChartAccount {
  id: string;
  company_id: string;
  code: string;
  name: string;
  section: CoaSection;
  parent_code: string | null;
  level: number;
  is_header: boolean;
  active: boolean;
  sort_order: number;
  created_at: string;
}

export interface ChartAccountCreate {
  code: string;
  name: string;
  section: CoaSection;
  parent_code?: string | null;
  level?: number;
  is_header?: boolean;
}

export interface InvoiceClassification {
  id: string;
  company_id: string;
  invoice_id: string;
  category_id: string | null;
  account_id: string | null;
  assigned_by: string;
  verified: boolean;
  ai_confidence: number | null;
  ai_reasoning: string | null;
  category?: Category | null;
  account?: ChartAccount | null;
}

export interface InvoiceProjectAssignment {
  id: string;
  company_id: string;
  invoice_id: string;
  project_id: string;
  percentage: number;
  amount: number | null;
  assigned_by: string;
  ai_confidence: number | null;
  project?: Project | null;
}

// ─── Section labels ───────────────────────────────────────

export const SECTION_LABELS: Record<CoaSection, string> = {
  assets: 'Attivita',
  liabilities: 'Passivita',
  equity: 'Patrimonio Netto',
  revenue: 'Ricavi',
  cost_production: 'Costi della produzione',
  cost_personnel: 'Costi del personale',
  depreciation: 'Ammortamenti',
  other_costs: 'Altri costi',
  financial: 'Oneri/Proventi finanziari',
  extraordinary: 'Straordinari',
};

export const CATEGORY_TYPE_LABELS: Record<CategoryType, string> = {
  revenue: 'Ricavo',
  expense: 'Costo',
  both: 'Entrambi',
};

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  active: 'Attivo',
  completed: 'Completato',
  suspended: 'Sospeso',
};

export const PROJECT_STATUS_COLORS: Record<ProjectStatus, string> = {
  active: 'bg-green-100 text-green-800',
  completed: 'bg-blue-100 text-blue-800',
  suspended: 'bg-yellow-100 text-yellow-800',
};

// Predefined color palette for color pickers
export const COLOR_PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#84cc16', '#22c55e', '#10b981', '#14b8a6',
  '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6',
  '#a855f7', '#d946ef', '#ec4899', '#64748b',
];

// ─── Categories CRUD ──────────────────────────────────────

export async function loadCategories(companyId: string, activeOnly = false): Promise<Category[]> {
  let q = supabase
    .from('categories')
    .select('*')
    .eq('company_id', companyId)
    .order('sort_order').order('name');
  if (activeOnly) q = q.eq('active', true);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []) as Category[];
}

export async function createCategory(companyId: string, data: CategoryCreate): Promise<Category> {
  const { data: row, error } = await supabase
    .from('categories')
    .insert({ company_id: companyId, ...data })
    .select()
    .single();
  if (error) throw error;
  // Fire-and-forget: generate embedding for new category
  if (row?.id) triggerEntityEmbedding(companyId, ['categories'], [row.id]).catch(() => {});
  return row as Category;
}

export async function updateCategory(id: string, data: Partial<CategoryCreate> & { active?: boolean }, companyId?: string): Promise<void> {
  const { error } = await supabase.from('categories').update(data).eq('id', id);
  if (error) throw error;
  // Fire-and-forget: re-embed updated category
  if (companyId) triggerEntityEmbedding(companyId, ['categories'], [id]).catch(() => {});
}

export async function deleteCategory(id: string): Promise<void> {
  const { error } = await supabase.from('categories').delete().eq('id', id);
  if (error) throw error;
}

// ─── Projects CRUD ────────────────────────────────────────

export async function loadProjects(companyId: string, activeOnly = false): Promise<Project[]> {
  let q = supabase
    .from('projects')
    .select('*')
    .eq('company_id', companyId)
    .order('sort_order').order('code');
  if (activeOnly) q = q.eq('status', 'active');
  const { data, error } = await q;
  if (error) throw error;
  return (data || []) as Project[];
}

export async function createProject(companyId: string, data: ProjectCreate): Promise<Project> {
  const { data: row, error } = await supabase
    .from('projects')
    .insert({ company_id: companyId, ...data })
    .select()
    .single();
  if (error) throw error;
  // Fire-and-forget: generate embedding for new project
  if (row?.id) triggerEntityEmbedding(companyId, ['projects'], [row.id]).catch(() => {});
  return row as Project;
}

export async function updateProject(id: string, data: Partial<ProjectCreate>, companyId?: string): Promise<void> {
  const { error } = await supabase.from('projects').update({ ...data, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
  // Fire-and-forget: re-embed updated project
  if (companyId) triggerEntityEmbedding(companyId, ['projects'], [id]).catch(() => {});
}

export async function deleteProject(id: string): Promise<void> {
  const { error } = await supabase.from('projects').delete().eq('id', id);
  if (error) throw error;
}

// ─── Chart of Accounts CRUD ──────────────────────────────

export async function loadChartOfAccounts(companyId: string): Promise<ChartAccount[]> {
  const { data, error } = await supabase
    .from('chart_of_accounts')
    .select('*')
    .eq('company_id', companyId)
    .order('sort_order').order('code');
  if (error) throw error;
  return (data || []) as ChartAccount[];
}

export async function createChartAccount(companyId: string, data: ChartAccountCreate): Promise<ChartAccount> {
  const { data: row, error } = await supabase
    .from('chart_of_accounts')
    .insert({ company_id: companyId, ...data })
    .select()
    .single();
  if (error) throw error;
  // Fire-and-forget: generate embedding for new account
  if (row?.id) triggerEntityEmbedding(companyId, ['chart_of_accounts'], [row.id]).catch(() => {});
  return row as ChartAccount;
}

export async function updateChartAccount(id: string, data: Partial<ChartAccountCreate> & { active?: boolean }, companyId?: string): Promise<void> {
  const { error } = await supabase.from('chart_of_accounts').update(data).eq('id', id);
  if (error) throw error;
  // Fire-and-forget: re-embed updated account
  if (companyId) triggerEntityEmbedding(companyId, ['chart_of_accounts'], [id]).catch(() => {});
}

export async function deleteChartAccount(id: string): Promise<void> {
  const { error } = await supabase.from('chart_of_accounts').delete().eq('id', id);
  if (error) throw error;
}

export async function importDefaultChartOfAccounts(companyId: string): Promise<number> {
  // Check if company already has accounts
  const { count } = await supabase
    .from('chart_of_accounts')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId);
  if ((count || 0) > 0) throw new Error('Il piano dei conti non e vuoto. Importazione possibile solo su tabella vuota.');

  const defaults: Omit<ChartAccountCreate, never>[] = [
    { code: '70', name: 'Valore della produzione', section: 'revenue' as CoaSection, level: 1, is_header: true },
    { code: '70000', name: 'Vendita pozzolana e materiale generico', section: 'revenue' as CoaSection, level: 2 },
    { code: '70002', name: 'Vendite calcare frantumato', section: 'revenue' as CoaSection, level: 2 },
    { code: '70003', name: 'Vendite minerale di calcare', section: 'revenue' as CoaSection, level: 2 },
    { code: '70004', name: 'Vendita materiale da estrazione', section: 'revenue' as CoaSection, level: 2 },
    { code: '70005', name: 'Ricavi per prestazioni di servizi', section: 'revenue' as CoaSection, level: 2 },
    { code: '70006', name: 'Ricavi da trasporto', section: 'revenue' as CoaSection, level: 2 },
    { code: '70007', name: 'Ricavi da noleggio', section: 'revenue' as CoaSection, level: 2 },
    { code: '70008', name: 'Ricavi da manutenzione mezzi', section: 'revenue' as CoaSection, level: 2 },
    { code: '70009', name: 'Ricavi da Scopertura Cave', section: 'revenue' as CoaSection, level: 2 },
    { code: '7000930', name: 'Ricavi per locazione', section: 'revenue' as CoaSection, level: 3 },
    { code: '7000940', name: 'Ricavi per cessione di rottami', section: 'revenue' as CoaSection, level: 3 },
    { code: '7050001', name: 'Contributo Sabatini', section: 'revenue' as CoaSection, level: 2 },
    { code: '7053020', name: 'Contributo Carbon tax', section: 'revenue' as CoaSection, level: 2 },
    { code: '7053024', name: 'Contributo Gasolio Autotrasportatori', section: 'revenue' as CoaSection, level: 2 },
    { code: '7054220', name: 'Credito Imposta Beni Strumentali', section: 'revenue' as CoaSection, level: 2 },
    { code: '7063001', name: 'Rimborso spese esplosivo', section: 'revenue' as CoaSection, level: 2 },
    { code: '60', name: 'Costi della produzione', section: 'cost_production' as CoaSection, level: 1, is_header: true },
    { code: '60100', name: 'Acquisto di merci e prodotti', section: 'cost_production' as CoaSection, level: 2 },
    { code: '60111', name: 'Acquisto carburanti e lubrificanti', section: 'cost_production' as CoaSection, level: 2 },
    { code: '60300', name: 'Materiale di consumo', section: 'cost_production' as CoaSection, level: 2 },
    { code: '60310', name: 'Materiali per manutenzione', section: 'cost_production' as CoaSection, level: 2 },
    { code: '60412', name: 'Trasporti su acquisti', section: 'cost_production' as CoaSection, level: 2 },
    { code: '60420', name: 'Acquisti di servizi', section: 'cost_production' as CoaSection, level: 2 },
    { code: '60702', name: 'Spese di Trasporto', section: 'cost_production' as CoaSection, level: 2 },
    { code: '60710', name: 'Prestazioni da terzi/Lavorazioni esterne', section: 'cost_production' as CoaSection, level: 2 },
    { code: '60720', name: 'Manutenzione automezzi 100%', section: 'cost_production' as CoaSection, level: 2 },
    { code: '60722', name: 'Manutenzione immobili/impianti', section: 'cost_production' as CoaSection, level: 2 },
    { code: '60726', name: 'Pezzi di ricambio', section: 'cost_production' as CoaSection, level: 2 },
    { code: '60730', name: 'Consulenza amministrativa/fiscale', section: 'cost_production' as CoaSection, level: 2 },
    { code: '60731', name: 'Consulenza del lavoro', section: 'cost_production' as CoaSection, level: 2 },
    { code: '60732', name: 'Consulenze diverse', section: 'cost_production' as CoaSection, level: 2 },
    { code: '60810', name: 'Trasporti per vendite', section: 'cost_production' as CoaSection, level: 2 },
    { code: '60812', name: 'Carburanti e lubrificanti 100%', section: 'cost_production' as CoaSection, level: 2 },
    { code: '60822', name: 'Assicurazioni automezzi', section: 'cost_production' as CoaSection, level: 2 },
    { code: '60830', name: 'Energia elettrica', section: 'cost_production' as CoaSection, level: 2 },
    { code: '60850', name: 'Elaborazione dati esterni', section: 'cost_production' as CoaSection, level: 2 },
    { code: '60859', name: 'Spese amministrative diverse', section: 'cost_production' as CoaSection, level: 2 },
    { code: '60872', name: 'Smaltimento rifiuti', section: 'cost_production' as CoaSection, level: 2 },
    { code: '60890', name: 'Pubblicita e propaganda', section: 'cost_production' as CoaSection, level: 2 },
    { code: '6090020', name: 'Locazione Cava', section: 'cost_production' as CoaSection, level: 2 },
    { code: '6090021', name: 'Noleggio Automezzi/Macchinari', section: 'cost_production' as CoaSection, level: 2 },
    { code: '60901', name: 'Affitto beni di terzi', section: 'cost_production' as CoaSection, level: 2 },
    { code: '6093', name: 'Canoni Leasing', section: 'cost_production' as CoaSection, level: 2, is_header: true },
    { code: '61', name: 'Costi per il personale', section: 'cost_personnel' as CoaSection, level: 1, is_header: true },
    { code: '61000', name: 'Salari e stipendi', section: 'cost_personnel' as CoaSection, level: 2 },
    { code: '61100', name: 'Contributi INPS', section: 'cost_personnel' as CoaSection, level: 2 },
    { code: '61200', name: 'TFR', section: 'cost_personnel' as CoaSection, level: 2 },
    { code: '61402', name: 'Rimborsi trasferte', section: 'cost_personnel' as CoaSection, level: 2 },
    { code: '62', name: 'Ammortamenti e svalutazioni', section: 'depreciation' as CoaSection, level: 1, is_header: true },
    { code: '62160', name: 'Ammortamento beni strumentali', section: 'depreciation' as CoaSection, level: 2 },
    { code: '63', name: 'Altri costi della produzione', section: 'other_costs' as CoaSection, level: 1, is_header: true },
    { code: '63207', name: 'Tassa possesso automezzi', section: 'other_costs' as CoaSection, level: 2 },
    { code: '63290', name: 'Mensa aziendale', section: 'other_costs' as CoaSection, level: 2 },
    { code: '64', name: 'Interessi e oneri finanziari', section: 'financial' as CoaSection, level: 1, is_header: true },
    { code: '64000', name: 'Interessi passivi', section: 'financial' as CoaSection, level: 2 },
    { code: '64330', name: 'Spese bancarie', section: 'financial' as CoaSection, level: 2 },
    { code: '72', name: 'Proventi finanziari', section: 'financial' as CoaSection, level: 1, is_header: true },
    { code: '72031', name: 'Altri proventi', section: 'financial' as CoaSection, level: 2 },
    { code: '72102', name: 'Interessi attivi BTP', section: 'financial' as CoaSection, level: 2 },
  ];

  const rows = defaults.map((d, i) => ({
    company_id: companyId,
    sort_order: (i + 1) * 10,
    is_header: false,
    ...d,
  }));

  const { error } = await supabase.from('chart_of_accounts').insert(rows);
  if (error) throw error;
  // Fire-and-forget: generate embeddings for all imported accounts
  triggerEntityEmbedding(companyId, ['chart_of_accounts']).catch(() => {});
  return rows.length;
}

// ─── Invoice Classification (madre) ──────────────────────

export async function loadInvoiceClassification(invoiceId: string): Promise<InvoiceClassification | null> {
  const { data, error } = await supabase
    .from('invoice_classifications')
    .select('*, category:categories(*), account:chart_of_accounts(*)')
    .eq('invoice_id', invoiceId)
    .maybeSingle();
  if (error) throw error;
  return data as InvoiceClassification | null;
}

export async function saveInvoiceClassification(
  companyId: string,
  invoiceId: string,
  categoryId: string | null,
  accountId: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('invoice_classifications')
    .upsert({
      company_id: companyId,
      invoice_id: invoiceId,
      category_id: categoryId,
      account_id: accountId,
      assigned_by: 'manual',
      verified: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'invoice_id' });
  if (error) throw error;

  // Mark invoice classification as confirmed (removes ⚡ AI suggestion indicator)
  await supabase.from('invoices').update({ classification_status: 'confirmed' } as any).eq('id', invoiceId);

  // RAG: create learning example for the classification (fire-and-forget)
  try {
    const { data: inv } = await supabase.from('invoices')
      .select('number, total_amount, counterparty')
      .eq('id', invoiceId).single()
    const { data: cat } = categoryId
      ? await supabase.from('categories').select('name').eq('id', categoryId).single()
      : { data: null }
    const { data: acc } = accountId
      ? await supabase.from('chart_of_accounts').select('code, name').eq('id', accountId).single()
      : { data: null }
    if (inv) {
      const cpName = (inv.counterparty as any)?.denom || null
      createClassificationExample(
        companyId, inv.number, cpName, inv.total_amount, null,
        cat?.name || null, acc?.code || null, acc?.name || null,
        categoryId, accountId, invoiceId,
      ).catch(err => console.warn('[saveInvoiceClassification] learning example error:', err))
    }
  } catch (err) {
    console.warn('[saveInvoiceClassification] learning example lookup error:', err)
  }
}

export async function deleteInvoiceClassification(invoiceId: string): Promise<void> {
  const { error } = await supabase
    .from('invoice_classifications')
    .delete()
    .eq('invoice_id', invoiceId);
  if (error) throw error;
}

// ─── Invoice Projects ─────────────────────────────────────

export async function loadInvoiceProjects(invoiceId: string): Promise<InvoiceProjectAssignment[]> {
  const { data, error } = await supabase
    .from('invoice_projects')
    .select('*, project:projects(*)')
    .eq('invoice_id', invoiceId)
    .order('created_at');
  if (error) throw error;
  return (data || []) as InvoiceProjectAssignment[];
}

export async function addInvoiceProject(
  companyId: string,
  invoiceId: string,
  projectId: string,
  percentage: number,
): Promise<void> {
  const { error } = await supabase
    .from('invoice_projects')
    .insert({
      company_id: companyId,
      invoice_id: invoiceId,
      project_id: projectId,
      percentage,
      assigned_by: 'manual',
    });
  if (error) throw error;
}

export async function updateInvoiceProjectPercentage(id: string, percentage: number): Promise<void> {
  const { error } = await supabase
    .from('invoice_projects')
    .update({ percentage })
    .eq('id', id);
  if (error) throw error;
}

export async function removeInvoiceProject(id: string): Promise<void> {
  const { error } = await supabase
    .from('invoice_projects')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

/** Batch save cost center allocations: delete all existing, insert new rows. */
export async function saveInvoiceProjects(
  companyId: string,
  invoiceId: string,
  assignments: { project_id: string; percentage: number; amount: number | null }[],
): Promise<void> {
  // Delete existing assignments for this invoice
  const { error: delErr } = await supabase
    .from('invoice_projects')
    .delete()
    .eq('invoice_id', invoiceId);
  if (delErr) throw delErr;

  if (assignments.length === 0) return;

  const rows = assignments.map(a => ({
    company_id: companyId,
    invoice_id: invoiceId,
    project_id: a.project_id,
    percentage: a.percentage,
    amount: a.amount,
    assigned_by: 'manual' as const,
  }));

  const { error } = await supabase.from('invoice_projects').insert(rows as any);
  if (error) throw error;
}

// ─── Fiscal alert types (from Sonnet escalation) ──────────────────────────────

export interface FiscalAlertOption {
  label: string;
  fiscal_override: Record<string, unknown>;
  is_default: boolean;
}

export interface FiscalAlert {
  type: 'deducibilita' | 'ritenuta' | 'reverse_charge' | 'split_payment' | 'bene_strumentale' | 'iva_indetraibile' | 'general';
  severity: 'warning' | 'info';
  title: string;
  description: string;
  current_choice: string;
  options: FiscalAlertOption[];
  affected_lines: string[];
}

/** Load invoice_notes (fiscal alerts) from invoice_classifications. */
export async function loadInvoiceNotes(invoiceId: string): Promise<FiscalAlert[]> {
  const { data, error } = await supabase
    .from('invoice_classifications')
    .select('invoice_notes')
    .eq('invoice_id', invoiceId)
    .maybeSingle();
  if (error || !data?.invoice_notes) return [];
  try {
    const notes = data.invoice_notes;
    return Array.isArray(notes) ? notes as FiscalAlert[] : [];
  } catch {
    return [];
  }
}

/** Clear invoice_notes and has_fiscal_alerts after user resolves all alerts. */
export async function clearInvoiceNotes(invoiceId: string): Promise<void> {
  await supabase
    .from('invoice_classifications')
    .update({ invoice_notes: null } as any)
    .eq('invoice_id', invoiceId);
  await supabase
    .from('invoices')
    .update({ has_fiscal_alerts: false } as any)
    .eq('id', invoiceId);
}

/** Save updated fiscal_flags on a single invoice line. */
export async function saveLineFiscalFlags(lineId: string, fiscalFlags: Record<string, unknown>): Promise<void> {
  const { error } = await supabase
    .from('invoice_lines')
    .update({ fiscal_flags: fiscalFlags } as any)
    .eq('id', lineId);
  if (error) throw error;
}

// ─── Line-level classification (category + account directly on invoice_lines) ───

export interface LineClassification {
  invoice_line_id: string;
  category_id: string | null;
  account_id: string | null;
}

/** Load line-level category/account + fiscal_flags for all lines in an invoice.
 *  Reads directly from invoice_lines — works independently of article assignment. */
export async function loadLineClassifications(invoiceId: string): Promise<{
  classifs: Record<string, LineClassification>;
  fiscalFlags: Record<string, any>;
}> {
  const { data, error } = await supabase
    .from('invoice_lines')
    .select('id, category_id, account_id, fiscal_flags')
    .eq('invoice_id', invoiceId);
  if (error) throw error;
  const classifs: Record<string, LineClassification> = {};
  const fiscalFlags: Record<string, any> = {};
  for (const row of (data || []) as { id: string; category_id: string | null; account_id: string | null; fiscal_flags: any }[]) {
    if (row.category_id || row.account_id) {
      classifs[row.id] = {
        invoice_line_id: row.id,
        category_id: row.category_id,
        account_id: row.account_id,
      };
    }
    if (row.fiscal_flags) {
      fiscalFlags[row.id] = row.fiscal_flags;
    }
  }
  return { classifs, fiscalFlags };
}

/** Clear category, account, and fiscal_flags on ALL lines of an invoice.
 *  Used by "Cancella tutto" to wipe line-level classification data. */
export async function clearAllLineClassifications(invoiceId: string): Promise<void> {
  const { error } = await supabase
    .from('invoice_lines')
    .update({ category_id: null, account_id: null, fiscal_flags: null } as any)
    .eq('invoice_id', invoiceId);
  if (error) throw error;
}

/** Save category and/or account on a single invoice line.
 *  Works independently of article assignment (updates invoice_lines directly). */
export async function saveLineCategoryAndAccount(
  lineId: string,
  categoryId: string | null,
  accountId: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('invoice_lines')
    .update({ category_id: categoryId, account_id: accountId } as any)
    .eq('id', lineId);
  if (error) throw error;
}

// ─── Line-level CdC (invoice_line_projects) ──────────────

export interface LineProjectAssignment {
  id: string;
  invoice_line_id: string;
  project_id: string;
  percentage: number;
  amount: number | null;
}

/** Load line-level CdC allocations for all lines in an invoice. */
export async function loadLineProjects(invoiceId: string): Promise<Record<string, LineProjectAssignment[]>> {
  const { data, error } = await supabase
    .from('invoice_line_projects')
    .select('id, invoice_line_id, project_id, percentage, amount')
    .eq('invoice_id', invoiceId);
  if (error) throw error;
  const map: Record<string, LineProjectAssignment[]> = {};
  for (const row of (data || []) as LineProjectAssignment[]) {
    if (!map[row.invoice_line_id]) map[row.invoice_line_id] = [];
    map[row.invoice_line_id].push(row);
  }
  return map;
}

/** Batch save line-level CdC allocations: delete existing for lineId, insert new rows. */
export async function saveLineProjects(
  companyId: string,
  invoiceId: string,
  lineId: string,
  assignments: { project_id: string; percentage: number; amount: number | null }[],
): Promise<void> {
  // Delete existing assignments for this line
  const { error: delErr } = await supabase
    .from('invoice_line_projects')
    .delete()
    .eq('invoice_line_id', lineId);
  if (delErr) throw delErr;

  if (assignments.length === 0) return;

  const rows = assignments.map(a => ({
    company_id: companyId,
    invoice_id: invoiceId,
    invoice_line_id: lineId,
    project_id: a.project_id,
    percentage: a.percentage,
    amount: a.amount,
    assigned_by: 'manual' as const,
  }));

  const { error } = await supabase.from('invoice_line_projects').insert(rows as any);
  if (error) throw error;
}

// ─── AI Suggestion Types & Helpers ────────────────────────

export interface AccountSuggestion {
  code: string;
  name: string;
  section: string;     // CoaSection value (e.g. 'cost_production', 'revenue')
  parent_code: string;
  reason: string;
}

export interface CategorySuggestion {
  name: string;
  type: string;        // 'expense' | 'revenue' (or Italian: 'Costo' | 'Ricavo')
  reason: string;
}

/**
 * Pick the first unused color from COLOR_PALETTE, or random if all taken.
 */
export function pickNextColor(existingColors: string[]): string {
  const used = new Set(existingColors.map(c => c.toLowerCase()));
  const available = COLOR_PALETTE.find(c => !used.has(c));
  return available || COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)];
}

/**
 * Create a new chart_of_accounts entry from an AI suggestion.
 * Handles duplicate code detection (auto-increments) and section validation.
 */
export async function createAccountFromSuggestion(
  companyId: string,
  suggestion: AccountSuggestion,
): Promise<ChartAccount> {
  // Validate section — fallback to 'other_costs' if AI hallucinated
  const validSections: CoaSection[] = [
    'assets', 'liabilities', 'equity', 'revenue',
    'cost_production', 'cost_personnel', 'depreciation',
    'other_costs', 'financial', 'extraordinary',
  ];
  const section = validSections.includes(suggestion.section as CoaSection)
    ? (suggestion.section as CoaSection)
    : 'other_costs';

  // Check for duplicate code → increment (180.30 → 180.31 → 180.32...)
  let code = suggestion.code;
  let attempts = 0;
  while (attempts < 10) {
    const { data: existing } = await supabase
      .from('chart_of_accounts')
      .select('id')
      .eq('company_id', companyId)
      .eq('code', code)
      .maybeSingle();
    if (!existing) break;
    // Increment the last numeric segment
    const parts = code.split('.');
    if (parts.length > 1) {
      const last = parseInt(parts[parts.length - 1] || '0', 10);
      parts[parts.length - 1] = String(last + 1);
    } else {
      // No dot separator — try appending .01
      parts.push(String(attempts + 1).padStart(2, '0'));
    }
    code = parts.join('.');
    attempts++;
  }

  const account = await createChartAccount(companyId, {
    code,
    name: suggestion.name,
    section,
    parent_code: suggestion.parent_code || null,
    level: 3,
    is_header: false,
  });
  // Fire-and-forget: generate embedding for the new account
  if (account?.id) {
    triggerEntityEmbedding(companyId, ['chart_of_accounts'], [account.id]).catch(() => {});
  }
  return account;
}

/**
 * Create a new category from an AI suggestion.
 * Detects existing categories with same name (case-insensitive) and returns them instead.
 */
export async function createCategoryFromSuggestion(
  companyId: string,
  suggestion: CategorySuggestion,
): Promise<{ category: Category; wasExisting: boolean }> {
  // Check for duplicate name (case-insensitive)
  const { data: existing } = await supabase
    .from('categories')
    .select('*')
    .eq('company_id', companyId)
    .ilike('name', suggestion.name)
    .maybeSingle();
  if (existing) return { category: existing as Category, wasExisting: true };

  // Pick an unused color
  const allCats = await loadCategories(companyId);
  const usedColors = allCats.map(c => c.color).filter(Boolean);
  const color = pickNextColor(usedColors);

  // Map AI type string to CategoryType
  const typeMap: Record<string, CategoryType> = {
    expense: 'expense', revenue: 'revenue', both: 'both',
    Costo: 'expense', Ricavo: 'revenue',
    costo: 'expense', ricavo: 'revenue',
  };
  const catType: CategoryType = typeMap[suggestion.type] || 'expense';

  const category = await createCategory(companyId, {
    name: suggestion.name,
    type: catType,
    color,
  });
  // Fire-and-forget: generate embedding for the new category
  if (category?.id) {
    triggerEntityEmbedding(companyId, ['categories'], [category.id]).catch(() => {});
  }
  return { category, wasExisting: false };
}
