// src/lib/classificationService.ts — CRUD for Categories, Projects, Chart of Accounts
// and invoice-level / line-level classification assignments.
import { supabase } from '@/integrations/supabase/client';

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
  category?: Category | null;
  account?: ChartAccount | null;
}

export interface InvoiceProjectAssignment {
  id: string;
  company_id: string;
  invoice_id: string;
  project_id: string;
  percentage: number;
  assigned_by: string;
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
  return row as Category;
}

export async function updateCategory(id: string, data: Partial<CategoryCreate> & { active?: boolean }): Promise<void> {
  const { error } = await supabase.from('categories').update(data).eq('id', id);
  if (error) throw error;
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
  return row as Project;
}

export async function updateProject(id: string, data: Partial<ProjectCreate>): Promise<void> {
  const { error } = await supabase.from('projects').update({ ...data, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
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
  return row as ChartAccount;
}

export async function updateChartAccount(id: string, data: Partial<ChartAccountCreate> & { active?: boolean }): Promise<void> {
  const { error } = await supabase.from('chart_of_accounts').update(data).eq('id', id);
  if (error) throw error;
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
