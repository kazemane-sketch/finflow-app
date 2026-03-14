// src/pages/FatturePage.tsx — v6
// Tab layout redesign: Classification-first UX with Documento/Pagamenti/Note tabs
import React, { startTransition, useState, useCallback, useRef, useEffect, useMemo, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { processInvoiceFile, TIPO, MP, REG, mpLabel, tpLabel, reparseXml as parseXmlDetail, extractPrimaryContractRef } from '@/lib/invoiceParser';
import {
  saveInvoicesToDB, loadInvoices, loadInvoiceDetail, loadInvoiceStats,
  deleteInvoices, updateInvoice, verifyPassword,
  fetchInvoiceAggregates, loadInvoiceClassificationMeta,
  type DBInvoice, type DBInvoiceDetail, type InvoiceUpdate, type InvoiceFilters,
  type InvoiceAggregates, type InvoiceClassificationMeta,
} from '@/lib/invoiceSaver';
import { listInstallmentsForInvoice, type InvoiceInstallment } from '@/lib/scadenzario';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '@/integrations/supabase/client';
import { getValidAccessToken } from '@/lib/getValidAccessToken';
import { useCompany } from '@/hooks/useCompany';
import { fmtNum, fmtEur, fmtDate } from '@/lib/utils';
import { useReconciliationBadges } from '@/hooks/useReconciliationBadges';
import { usePageEntity } from '@/contexts/PageEntityContext';
import { ReconciledIcon, ReconciliationDot } from '@/components/ReconciliationIndicators';
import { triggerAutoReconciliation } from '@/lib/reconciliationTrigger';
import { useAIJob } from '@/hooks/useAIJob';
import type { AIJob } from '@/stores/useAIJobStore';
import {
  subscribeExtraction, getExtractionState,
  loadExtractionStats as loadExtStats,
} from '@/lib/extractionStore';
import {
  loadArticlesWithPhases, assignArticleToLine, removeLineAssignment, recordAssignmentFeedback, loadLearnedRules,
  type Article, type ArticleWithPhases, type ArticlePhase, type MatchResult,
} from '@/lib/articlesService';
import { matchWithLearnedRules, extractLocation, type LearnedRule } from '@/lib/articleMatching';
import {
  loadCategories, loadProjects, loadChartOfAccounts,
  loadInvoiceClassification, saveInvoiceClassification, deleteInvoiceClassification,
  loadInvoiceProjects, saveInvoiceProjects,
  loadLineClassifications, saveLineCategoryAndAccount, clearAllLineClassifications,
  loadLineProjects, saveLineProjects, clearAllLineProjects,
  loadInvoiceNotes, clearInvoiceNotes, saveLineFiscalFlags,
  promoteLineToClassify,
  CATEGORY_TYPE_LABELS, SECTION_LABELS,
  createAccountFromSuggestion, createCategoryFromSuggestion,
  type Category, type Project, type ChartAccount, type CoaSection, type CategoryType,
  type InvoiceClassification, type InvoiceProjectAssignment,
  type LineClassification, type LineProjectAssignment, type LineActionMeta, type LineDetailData,
  type AccountSuggestion, type CategorySuggestion,
  type FiscalAlert, type FiscalAlertOption,
} from '@/lib/classificationService';
import { toast } from 'sonner';
import { createRuleFromConfirmation, findMatchingRules, deactivateRulesForInvoice, handleRuleCorrection, type RuleSuggestion } from '@/lib/classificationRulesService';
import { runClassificationPipeline, type PipelineStepDebug } from '@/lib/classificationPipelineService';
import { createMemoryFromClassification, createMemoryFromFiscalChoice, deleteInvoiceMemoryFacts } from '@/lib/companyMemoryService';
import { extractProvinceSiglaFromAddress, loadCounterpartyHeaderInfo } from '@/lib/counterpartyService';
import { deleteFiscalDecisionsForInvoice, saveFiscalDecision } from '@/lib/fiscalDecisionService';
import { applyConsultantResolution, clearInvoiceDecisionTrail, type SupportingEvidence } from '@/lib/invoiceDecisionService';
import { invokeAiAssistant } from '@/lib/aiAssistantClient';
import ExportDialog from '@/components/ExportDialog';
import SearchableSelect from '@/components/SearchableSelect';
import { ConfidenceBadge, FiscalFlagsBadges, AIAssistantBanner } from '@/components/invoice';
import type { BannerStatus, ChatMessage, ConsultantAction } from '@/components/invoice';
import {
  STATUS_LABELS, getStatusLabel, STATUS_COLORS,
  Sec, Row, getFinalReasoningSummary, getPendingDecisionReason,
  ConfirmDeleteModal, EditForm, ImportProgress, ReviewBadge,
  PipelineStepDetailPanel, SingleInvoiceAIProgressCard,
  InvoiceCard, ArticleDropdown, PhaseDropdown, type ImportLog, type LineArticleInfo
} from '@/components/invoice/InvoiceSharedComponents';
import { askInvoiceAiSearch, type InvoiceAiResult } from '@/lib/invoiceAiSearch';
import { InvoiceDetail } from '@/components/invoice/InvoiceDetail';

// ============================================================
// LOOKUPS
// ============================================================
const NAT: Record<string, string> = {
  N1: 'Escl. art.15', N2: 'Non soggette', 'N2.1': 'Non sogg. art.7', 'N2.2': 'Non sogg. altri',
  N3: 'Non imponibili', 'N3.1': 'Esportaz.', 'N3.2': 'Cess. intra.', 'N3.3': 'S.Marino',
  'N3.4': 'Op. assimilate', 'N3.5': 'Dich. intento', 'N3.6': 'Altre', N4: 'Esenti',
  N5: 'Margine', N6: 'Reverse charge', 'N6.1': 'Rottami', 'N6.2': 'Oro',
  'N6.3': 'Subapp. edil.', 'N6.4': 'Fabbricati', 'N6.5': 'Cellulari',
  'N6.6': 'Elettronici', 'N6.7': 'Edile', 'N6.8': 'Energia', 'N6.9': 'RC altri',
  N7: 'IVA in altro UE',
};
// CPC removed — now using shared TP + tpLabel from invoiceParser
const ESI: Record<string, string> = { I: 'Immediata', D: 'Differita', S: 'Split payment' };
const RIT: Record<string, string> = { RT01: 'Pers. fisiche', RT02: 'Pers. giuridiche', RT03: 'INPS', RT04: 'ENASARCO', RT05: 'ENPAM' };
// STATUS LOOKUPS MOVED AROUND

// ============================================================
// SAFE NUMBER HELPER — evita NaN quando il campo XML è vuoto
// ============================================================
const safeFloat = (v: any): number => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

// ============================================================
// FULL INVOICE DETAIL — matches artifact output
// ============================================================
type DetailTab = 'dettaglio' | 'documento' | 'pagamenti' | 'note';
const DETAIL_TABS: { key: DetailTab; label: string }[] = [
  { key: 'dettaglio', label: 'Dettaglio' },
  { key: 'documento', label: 'Documento' },
  { key: 'pagamenti', label: 'Pagamenti' },
  { key: 'note', label: 'Note' },
];

type FattureReturnFilters = {
  direction: 'all' | 'in' | 'out';
  status: 'all' | 'pending' | 'overdue' | 'paid';
  aiSuggested: boolean;
  dateFrom: string;
  dateTo: string;
  query: string;
  amountMin?: number;
  amountMax?: number;
  counterpartyPattern?: string;
};

type FattureReturnContext = {
  origin: 'invoice-counterparty';
  selectedInvoiceId: string;
  filters: FattureReturnFilters;
  loadedPageIndex: number;
  sidebarScrollTop: number;
};

type PrefetchedInvoiceLoadResult = {
  data: DBInvoice[];
  count: number;
  lastPageLength: number;
  lastLoadedPageIndex: number;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseFiniteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readFattureReturnContext(state: unknown): FattureReturnContext | null {
  const root = isPlainRecord(state) ? state : null;
  const raw = root && isPlainRecord(root.returnContext) ? root.returnContext : null;
  if (!raw) return null;

  const selectedInvoiceId = typeof raw.selectedInvoiceId === 'string' ? raw.selectedInvoiceId.trim() : '';
  const rawFilters = isPlainRecord(raw.filters) ? raw.filters : {};
  if (raw.origin !== 'invoice-counterparty' || !selectedInvoiceId) return null;

  const rawDirection = rawFilters.direction;
  const rawStatus = rawFilters.status;
  const direction = rawDirection === 'all' || rawDirection === 'in' || rawDirection === 'out' ? rawDirection : 'in';
  const status = rawStatus === 'all' || rawStatus === 'pending' || rawStatus === 'overdue' || rawStatus === 'paid'
    ? rawStatus
    : 'all';

  return {
    origin: 'invoice-counterparty',
    selectedInvoiceId,
    filters: {
      direction,
      status,
      aiSuggested: Boolean(rawFilters.aiSuggested),
      dateFrom: typeof rawFilters.dateFrom === 'string' ? rawFilters.dateFrom : '',
      dateTo: typeof rawFilters.dateTo === 'string' ? rawFilters.dateTo : '',
      query: typeof rawFilters.query === 'string' ? rawFilters.query : '',
      amountMin: parseFiniteNumber(rawFilters.amountMin),
      amountMax: parseFiniteNumber(rawFilters.amountMax),
      counterpartyPattern: typeof rawFilters.counterpartyPattern === 'string' && rawFilters.counterpartyPattern.trim()
        ? rawFilters.counterpartyPattern
        : undefined,
    },
    loadedPageIndex: Math.max(0, Math.floor(parseFiniteNumber(raw.loadedPageIndex) ?? 0)),
    sidebarScrollTop: Math.max(0, parseFiniteNumber(raw.sidebarScrollTop) ?? 0),
  };
}

function replaceCurrentHistoryLocationState(nextLocationState: Record<string, unknown>) {
  if (typeof window === 'undefined') return;
  const currentHistoryState = isPlainRecord(window.history.state) ? window.history.state : {};
  window.history.replaceState(
    { ...currentHistoryState, usr: nextLocationState },
    '',
    window.location.href,
  );
}

function writeFattureReturnContext(context: FattureReturnContext) {
  if (typeof window === 'undefined') return;
  const currentHistoryState = isPlainRecord(window.history.state) ? window.history.state : {};
  const currentLocationState = isPlainRecord(currentHistoryState.usr) ? currentHistoryState.usr : {};
  replaceCurrentHistoryLocationState({
    ...currentLocationState,
    returnContext: context,
  });
}

function consumeFattureReturnContextFromHistory() {
  if (typeof window === 'undefined') return;
  const currentHistoryState = isPlainRecord(window.history.state) ? window.history.state : {};
  const currentLocationState = isPlainRecord(currentHistoryState.usr) ? currentHistoryState.usr : {};
  if (!('returnContext' in currentLocationState)) return;
  const { returnContext: _ignored, ...rest } = currentLocationState;
  replaceCurrentHistoryLocationState(rest);
}

/* ─── Aggregate fiscal alerts from AI pipeline ─── */
export function buildAggregatedNotes(
  pipelineAlerts: FiscalAlert[],
  _fiscalFlags: Record<string, any>,
): FiscalAlert[] {
  // Pipeline alerts (from commercialista doubts + CFO) are the sole source.
  // Legacy regex-based alert generation from fiscal_flags.note has been removed
  // because it produced incorrect alerts (e.g. "ammortamento" on leasing canoni).
  return [...pipelineAlerts];
}

export type InvoiceDetailPhase = 'idle' | 'loading' | 'ready' | 'refreshing';

export type InvoiceLineArticleAssignmentRow = {
  invoice_line_id: string
  article_id: string
  phase_id: string | null
  assigned_by: string
  verified: boolean
  location: string | null
  confidence: number | null
  article: {
    id: string
    code: string
    name: string
    unit?: string | null
    keywords?: string[]
  } | null
}

export type InvoiceDetailBundle = {
  invoiceId: string
  detail: DBInvoiceDetail | null
  installments: InvoiceInstallment[]
  classification: InvoiceClassification | null
  invoiceProjects: InvoiceProjectAssignment[]
  lineClassifs: Record<string, LineClassification>
  lineFiscalFlags: Record<string, any>
  lineConfidences: Record<string, number>
  lineReviewFlags: Record<string, boolean>
  lineActions: Record<string, import('@/lib/classificationService').LineActionMeta>
  lineDetails: Record<string, LineDetailData>
  lineProjects: Record<string, LineProjectAssignment[]>
  invoiceNotes: FiscalAlert[]
  lineAssignments: InvoiceLineArticleAssignmentRow[]
}

export type InvoiceReferenceData = {
  articles: ArticleWithPhases[]
  learnedRules: LearnedRule[]
  categories: Category[]
  projects: Project[]
  accounts: ChartAccount[]
}

export const EMPTY_INVOICE_CLASSIF_META: InvoiceClassificationMeta = {
  line_count: 0,
  assigned_count: 0,
  lines_with_category: 0,
  lines_with_account: 0,
  lines_with_cdc: 0,
  lines_with_article: 0,
  lines_with_complete_article: 0,
  review_count: 0,
  has_category: false,
  has_account: false,
  has_cost_center: false,
  has_article: false,
}

export const EMPTY_INVOICE_REFERENCE_DATA: InvoiceReferenceData = {
  articles: [],
  learnedRules: [],
  categories: [],
  projects: [],
  accounts: [],
};

async function loadInvoiceLineAssignments(invoiceId: string): Promise<InvoiceLineArticleAssignmentRow[]> {
  const { data, error } = await supabase
    .from('invoice_line_articles')
    .select('invoice_line_id, article_id, phase_id, assigned_by, verified, location, confidence, article:articles!inner(id, code, name, unit, keywords)')
    .eq('invoice_id', invoiceId);
  if (error) throw error;
  return (data || []) as unknown as InvoiceLineArticleAssignmentRow[];
}

async function loadInvoiceDetailBundle(companyId: string, invoiceId: string): Promise<InvoiceDetailBundle> {
  const [
    detail,
    installments,
    classification,
    invoiceProjects,
    lineClfResult,
    lineProjects,
    invoiceNotes,
    lineAssignments,
  ] = await Promise.all([
    loadInvoiceDetail(invoiceId),
    listInstallmentsForInvoice(companyId, invoiceId),
    loadInvoiceClassification(invoiceId),
    loadInvoiceProjects(invoiceId),
    loadLineClassifications(invoiceId),
    loadLineProjects(invoiceId),
    loadInvoiceNotes(invoiceId),
    loadInvoiceLineAssignments(invoiceId),
  ]);

  return {
    invoiceId,
    detail,
    installments,
    classification,
    invoiceProjects,
    lineClassifs: lineClfResult.classifs,
    lineFiscalFlags: lineClfResult.fiscalFlags,
    lineConfidences: lineClfResult.confidences,
    lineReviewFlags: lineClfResult.reviewFlags,
    lineActions: lineClfResult.lineActions,
    lineDetails: lineClfResult.lineDetails,
    lineProjects,
    invoiceNotes,
    lineAssignments,
  };
}

export function hasAnyLineProjects(lineProjects: Record<string, LineProjectAssignment[]>): boolean {
  return Object.values(lineProjects).some(assignments => assignments.length > 0);
}

export type PendingFiscalChoice = {
  first_line_id: string
  alert_type: string
  alert_title: string
  chosen_option_label: string
  fiscal_override: Record<string, unknown>
  affected_lines: string[]
  line_description: string
  contract_ref: string | null
  account_id: string | null
}

export default function FatturePage() {
  const { company, loading: companyLoading, ensureCompany, refetch: refetchCompany } = useCompany();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const companyId = company?.id || null;
  const { matchedInvoiceIds, invoiceScores, refresh: refreshBadges } = useReconciliationBadges();
  const { setEntity: setPageEntity } = usePageEntity();
  const initialReturnContextRef = useRef<FattureReturnContext | null>(readFattureReturnContext(location.state));
  const pendingReturnContextRef = useRef<FattureReturnContext | null>(initialReturnContextRef.current);
  const pendingSidebarRestoreRef = useRef<FattureReturnContext | null>(initialReturnContextRef.current);
  const loadedPageRef = useRef(initialReturnContextRef.current?.loadedPageIndex ?? 0);
  const invoiceListScrollRef = useRef<HTMLDivElement>(null);
  const invoiceRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const initialReturnFilters = initialReturnContextRef.current?.filters;
  const [invoices, setInvoices] = useState<DBInvoice[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialReturnContextRef.current?.selectedInvoiceId || null);
  const [detailBundle, setDetailBundle] = useState<InvoiceDetailBundle | null>(null);
  const [detailPhase, setDetailPhase] = useState<InvoiceDetailPhase>('idle');
  const [referenceData, setReferenceData] = useState<InvoiceReferenceData>(EMPTY_INVOICE_REFERENCE_DATA);
  const [referenceDataLoading, setReferenceDataLoading] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const invoiceBundleCacheRef = useRef<Map<string, InvoiceDetailBundle>>(new Map());
  const invoiceBundleInFlightRef = useRef<Map<string, Promise<InvoiceDetailBundle>>>(new Map());
  const invoiceBundleVersionRef = useRef<Map<string, number>>(new Map());
  const detailRequestTokenRef = useRef(0);

  // Pagination
  const PAGE_SIZE = 50;
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(0);
  const [allLoaded, setAllLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [debouncedQuery, setDebouncedQuery] = useState(initialReturnFilters?.query || '');
  const queryDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [serverStats, setServerStats] = useState<{ total: number; daPagare: number; scadute: number; pagate: number } | null>(null);
  const [tabCounts, setTabCounts] = useState<{ in: number; out: number }>({ in: 0, out: 0 });
  const [aiSuggestedCount, setAiSuggestedCount] = useState(0);
  const [importing, setImporting] = useState(false);
  const [importPhase, setImportPhase] = useState<'reading' | 'saving' | 'done'>('reading');
  const [importCurrent, setImportCurrent] = useState(0);
  const [importTotal, setImportTotal] = useState(0);
  const [importLogs, setImportLogs] = useState<ImportLog[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(initialReturnFilters?.query || '');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'overdue' | 'paid'>(initialReturnFilters?.status || 'all');
  const [aiSuggestedFilter, setAiSuggestedFilter] = useState(Boolean(initialReturnFilters?.aiSuggested));
  const [directionFilter, setDirectionFilter] = useState<'all' | 'in' | 'out'>(initialReturnFilters?.direction || 'in');
  const [selectMode, setSelectMode] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [deleteModal, setDeleteModal] = useState<{ open: boolean; ids: string[] }>({ open: false, ids: [] });

  // ── Date filter ──
  const [dateFrom, setDateFrom] = useState(initialReturnFilters?.dateFrom || '');
  const [dateTo, setDateTo] = useState(initialReturnFilters?.dateTo || '');

  // ── Export dialog ──
  const [exportOpen, setExportOpen] = useState(false);

  // ── Classification metadata for sidebar icons ──
  const [classifMeta, setClassifMeta] = useState<Map<string, InvoiceClassificationMeta>>(new Map());

  // Refresh classification metadata for a single invoice (called after confirm/save)
  const refreshClassifMeta = useCallback(async (invoiceId: string) => {
    if (!companyId) return;
    try {
      const meta = await loadInvoiceClassificationMeta(companyId, [invoiceId]);
      setClassifMeta(prev => {
        const next = new Map(prev);
        const m = meta.get(invoiceId);
        if (m) next.set(invoiceId, m); else next.delete(invoiceId);
        return next;
      });
    } catch (err) { console.error('refreshClassifMeta error:', err); }
  }, [companyId]);

  const setInvoiceClassifMeta = useCallback((invoiceId: string, meta: InvoiceClassificationMeta | null) => {
    setClassifMeta(prev => {
      const next = new Map(prev);
      if (meta) next.set(invoiceId, meta);
      else next.delete(invoiceId);
      return next;
    });
  }, []);

  useEffect(() => {
    invoiceBundleCacheRef.current.clear();
    invoiceBundleInFlightRef.current.clear();
    invoiceBundleVersionRef.current.clear();
    if (!companyId) {
      setReferenceData(EMPTY_INVOICE_REFERENCE_DATA);
      setReferenceDataLoading(false);
      return;
    }
    let cancelled = false;
    setReferenceDataLoading(true);
    Promise.all([
      loadArticlesWithPhases(companyId, { activeOnly: true }),
      loadLearnedRules(companyId),
      loadCategories(companyId, true),
      loadProjects(companyId, true),
      loadChartOfAccounts(companyId),
    ])
      .then(([articles, learnedRules, categories, projects, accounts]) => {
        if (cancelled) return;
        setReferenceData({
          articles,
          learnedRules,
          categories,
          projects,
          accounts: accounts.filter(account => !account.is_header && account.active),
        });
        setReferenceDataLoading(false);
      })
      .catch(error => {
        if (cancelled) return;
        console.error('Reference data load error:', error);
        setReferenceData(EMPTY_INVOICE_REFERENCE_DATA);
        setReferenceDataLoading(false);
      });
    return () => { cancelled = true; };
  }, [companyId]);

  const invalidateInvoiceBundle = useCallback((invoiceId: string) => {
    invoiceBundleCacheRef.current.delete(invoiceId);
    invoiceBundleInFlightRef.current.delete(invoiceId);
    const currentVersion = invoiceBundleVersionRef.current.get(invoiceId) || 0;
    invoiceBundleVersionRef.current.set(invoiceId, currentVersion + 1);
  }, []);

  const loadCachedInvoiceBundle = useCallback(async (invoiceId: string, options?: { force?: boolean }) => {
    if (!companyId) throw new Error('Company non disponibile');
    const force = options?.force === true;
    const requestVersion = invoiceBundleVersionRef.current.get(invoiceId) || 0;
    if (!force) {
      const cached = invoiceBundleCacheRef.current.get(invoiceId);
      if (cached) return cached;
      const inFlight = invoiceBundleInFlightRef.current.get(invoiceId);
      if (inFlight) return inFlight;
    }

    const request = loadInvoiceDetailBundle(companyId, invoiceId)
      .then(bundle => {
        if ((invoiceBundleVersionRef.current.get(invoiceId) || 0) === requestVersion) {
          invoiceBundleCacheRef.current.set(invoiceId, bundle);
        }
        invoiceBundleInFlightRef.current.delete(invoiceId);
        return bundle;
      })
      .catch(error => {
        invoiceBundleInFlightRef.current.delete(invoiceId);
        throw error;
      });

    invoiceBundleInFlightRef.current.set(invoiceId, request);
    return request;
  }, [companyId]);

  const prefetchInvoiceBundle = useCallback((invoiceId: string) => {
    if (!companyId) return;
    if (invoiceBundleCacheRef.current.has(invoiceId) || invoiceBundleInFlightRef.current.has(invoiceId)) return;
    void loadCachedInvoiceBundle(invoiceId).catch(error => {
      console.warn('[fatture] prefetch bundle error:', error);
    });
  }, [companyId, loadCachedInvoiceBundle]);

  const handleSelectInvoice = useCallback((invoiceId: string) => {
    const cached = invoiceBundleCacheRef.current.get(invoiceId) || null;
    setSelectedId(invoiceId);
    if (cached) {
      setDetailBundle(cached);
      setDetailPhase('ready');
      return;
    }
    setDetailBundle(null);
    setDetailPhase('loading');
  }, []);

  // ── AI search (BancaPage-style: filter + analysis modes) ──
  const [aiResult, setAiResult] = useState<InvoiceAiResult | null>(null);
  const [aiSearching, setAiSearching] = useState(false);
  const [aiError, setAiError] = useState('');

  // ── AI filter state (structured filters from AI classification) ──
  const [amountMin, setAmountMin] = useState<number | undefined>(initialReturnFilters?.amountMin);
  const [amountMax, setAmountMax] = useState<number | undefined>(initialReturnFilters?.amountMax);
  const [counterpartyPattern, setCounterpartyPattern] = useState<string | undefined>(initialReturnFilters?.counterpartyPattern);

  // ── Batch AI Classification ──
  const { isRunning: batchClassifRunning, progress: batchClassifJobProgress, startOrStop: classifStartOrStop } = useAIJob('fatture-classify', 'Classificazione Fatture AI');
  const [reloadTrigger, setReloadTrigger] = useState(0);

  const runBatchAiClassification = useCallback(() => {
    const companyId = company?.id;
    if (!companyId) return;
    classifStartOrStop(async (signal, updateProgress) => {
      // Paginated fetch of ALL invoice IDs + counterparty data (Supabase max 1000 per call)
      const PAGE = 1000;
      const allInvoices: { id: string; counterparty: any; direction: string }[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data } = await supabase
          .from('invoices')
          .select('id, counterparty, direction')
          .eq('company_id', companyId)
          .eq('direction', directionFilter)
          .range(from, from + PAGE - 1);
        if (signal.aborted) return;
        if (!data || data.length === 0) break;
        for (const r of data) allInvoices.push(r as any);
        if (data.length < PAGE) break;
      }

      // Paginated fetch of ALL classified invoice IDs
      const classifiedSet = new Set<string>();
      for (let from = 0; ; from += PAGE) {
        const { data } = await supabase
          .from('invoice_classifications')
          .select('invoice_id')
          .eq('company_id', companyId)
          .range(from, from + PAGE - 1);
        if (signal.aborted) return;
        if (!data || data.length === 0) break;
        for (const r of data) classifiedSet.add(r.invoice_id);
        if (data.length < PAGE) break;
      }

      const unclassified = allInvoices.filter((inv) => !classifiedSet.has(inv.id));
      if (unclassified.length === 0) return;

      updateProgress(0, unclassified.length);
      let successCount = 0;
      let failedCount = 0;

      // Process 2 invoices in parallel (pipeline is heavier than monolithic)
      const PARALLEL = 2;
      for (let i = 0; i < unclassified.length; i += PARALLEL) {
        if (signal.aborted) return;
        const batch = unclassified.slice(i, i + PARALLEL);

        const results = await Promise.all(
          batch.map(async (inv) => {
            try {
              // Load invoice lines
              const { data: lines } = await supabase
                .from('invoice_lines')
                .select('id, description, quantity, unit_price, total_price, vat_rate')
                .eq('invoice_id', inv.id)
                .order('line_number');
              if (!lines || lines.length === 0) return { ok: false };

              const cp = (inv.counterparty || {}) as any;

              // Run the v2 cascade pipeline (deterministic → commercialista → CdC → fiscal review)
              await runClassificationPipeline(
                companyId,
                inv.id,
                lines.map(l => ({
                  line_id: l.id,
                  description: l.description,
                  quantity: l.quantity,
                  unit_price: l.unit_price,
                  total_price: l.total_price,
                  vat_rate: l.vat_rate,
                })),
                inv.direction as 'in' | 'out',
                cp?.piva || null,
                cp?.denom || null,
                signal,
              );

              return { ok: true };
            } catch (fetchErr: any) {
              if (fetchErr?.name === 'AbortError') throw fetchErr;
              console.error('Pipeline classification error:', fetchErr);
              return { ok: false };
            }
          }),
        );

        for (let j = 0; j < results.length; j++) {
          if (results[j].ok) successCount++;
          else failedCount++;
        }
        updateProgress(Math.min(i + PARALLEL, unclassified.length), unclassified.length);
      }

      if (failedCount > 0 && successCount === 0) {
        throw new Error(`Classificazione fallita per tutte le ${unclassified.length} fatture`);
      } else if (failedCount > 0) {
        console.warn(`Classificate ${successCount} fatture. ${failedCount} errori.`);
      }
      setReloadTrigger(t => t + 1);
    });
  }, [company?.id, directionFilter, classifStartOrStop]);

  // ── Invoice extraction summary (AI) — now uses global AI job system ──
  const { isRunning: extractionRunning, progress: extractionJobProgress, startOrStop: extractionStartOrStop } = useAIJob('fatture-extract', 'Estrazione Dettagli Fatture');
  const ext = useSyncExternalStore(subscribeExtraction, getExtractionState);
  const extractionStats = ext.stats;

  const runExtraction = useCallback(() => {
    if (!companyId) return;
    extractionStartOrStop(async (signal, updateProgress) => {
      let totalProcessed = 0;
      let token = await getValidAccessToken();
      const BATCH = 10;
      while (!signal.aborted) {
        // Fetch batch of unclassified invoices
        const { data: pending, error: fetchErr } = await supabase
          .from('invoices')
          .select('id, counterparty, direction')
          .eq('company_id', companyId)
          .or('classification_status.is.null,classification_status.eq.pending')
          .limit(BATCH);
        if (fetchErr) throw new Error(fetchErr.message);
        if (!pending || pending.length === 0) break;

        // Refresh token at each batch to avoid expiry during long runs
        token = await getValidAccessToken();

        for (const inv of pending) {
          if (signal.aborted) break;
          const { data: lines } = await supabase
            .from('invoice_lines')
            .select('id, description, quantity, unit_price, total_price, vat_rate')
            .eq('invoice_id', inv.id);
          if (!lines || lines.length === 0) { totalProcessed++; continue; }
          const cp = inv.counterparty as Record<string, string> | null;
          // Run v2 cascade pipeline (same as batch classification)
          await runClassificationPipeline(
            companyId,
            inv.id,
            lines.map(l => ({
              line_id: l.id,
              description: l.description || '',
              quantity: l.quantity,
              unit_price: l.unit_price,
              total_price: l.total_price,
              vat_rate: l.vat_rate,
            })),
            (inv.direction || 'in') as 'in' | 'out',
            cp?.piva || null,
            cp?.denom || null,
            signal,
          );
          totalProcessed++;
          updateProgress(totalProcessed, totalProcessed + Math.max(0, pending.length - 1));
        }

        // Re-count remaining
        const { count } = await supabase
          .from('invoices')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .or('classification_status.is.null,classification_status.eq.pending');
        updateProgress(totalProcessed, totalProcessed + (count || 0));
        if ((count || 0) <= 0) break;
      }
      loadExtStats(companyId, invoices.length);
    });
  }, [companyId, invoices.length, extractionStartOrStop]);

  const loadExtractionStats = useCallback(() => {
    if (!companyId) return;
    loadExtStats(companyId, invoices.length);
  }, [companyId, invoices.length]);

  // Debounce text query
  useEffect(() => {
    clearTimeout(queryDebounceRef.current);
    queryDebounceRef.current = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(queryDebounceRef.current);
  }, [query]);

  const resetAllFilters = useCallback(() => {
    setDateFrom(''); setDateTo(''); setStatusFilter('all'); setAiSuggestedFilter(false);
    setAmountMin(undefined); setAmountMax(undefined); setCounterpartyPattern(undefined);
  }, []);

  const buildFilters = useCallback((): InvoiceFilters => ({
    direction: directionFilter,
    status: aiSuggestedFilter ? 'all' : statusFilter,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    query: debouncedQuery || undefined,
    candidateIds: aiResult?.candidateIds?.length ? aiResult.candidateIds : undefined,
    amountMin,
    amountMax,
    counterpartyPattern,
    classificationStatus: aiSuggestedFilter ? 'ai_suggested' : undefined,
  }), [directionFilter, statusFilter, dateFrom, dateTo, debouncedQuery, aiResult?.candidateIds, amountMin, amountMax, counterpartyPattern, aiSuggestedFilter]);

  const loadInvoicePagesUpTo = useCallback(async (
    filters: InvoiceFilters,
    lastPageIndex: number,
    selectedInvoiceId?: string,
  ): Promise<PrefetchedInvoiceLoadResult> => {
    const merged = new Map<string, DBInvoice>();
    let currentPage = 0;
    let count = 0;
    let lastPageLength = 0;
    let lastLoadedPageIndex = 0;

    while (true) {
      const result = await loadInvoices(companyId!, filters, { page: currentPage, pageSize: PAGE_SIZE });
      count = result.count;
      lastPageLength = result.data.length;
      lastLoadedPageIndex = currentPage;

      for (const invoice of result.data) {
        merged.set(invoice.id, invoice);
      }

      const reachedRequestedPage = currentPage >= lastPageIndex;
      const foundSelectedInvoice = !selectedInvoiceId || merged.has(selectedInvoiceId);
      const reachedEnd = result.data.length < PAGE_SIZE || (currentPage + 1) * PAGE_SIZE >= count;

      if ((reachedRequestedPage && foundSelectedInvoice) || reachedEnd) {
        break;
      }

      currentPage += 1;
    }

    return {
      data: Array.from(merged.values()),
      count,
      lastPageLength,
      lastLoadedPageIndex,
    };
  }, [companyId, PAGE_SIZE]);

  const reload = useCallback(async (reset = true) => {
    if (!companyId) return;
    if (reset) {
      setLoadingList(true);
      setPage(0);
      setAllLoaded(false);
    } else {
      setLoadingMore(true);
    }
    const currentPage = reset ? 0 : page;
    const filters = buildFilters();
    try {
      const restoreContext = reset ? pendingReturnContextRef.current : null;
      const restoreTargetPage = restoreContext ? Math.max(0, restoreContext.loadedPageIndex) : 0;
      const prefetchedResult = restoreContext
        ? await loadInvoicePagesUpTo(filters, restoreTargetPage, restoreContext.selectedInvoiceId)
        : null;
      const result = prefetchedResult
        ?? await loadInvoices(companyId, filters, { page: currentPage, pageSize: PAGE_SIZE });
      if (reset) {
        setInvoices(result.data);
        loadedPageRef.current = restoreContext ? (prefetchedResult?.lastLoadedPageIndex ?? restoreTargetPage) : 0;
        if (restoreContext) {
          pendingSidebarRestoreRef.current = restoreContext;
          pendingReturnContextRef.current = null;
          setSelectedId(restoreContext.selectedInvoiceId);
          const restoredPage = prefetchedResult?.lastLoadedPageIndex ?? restoreTargetPage;
          if (restoredPage > 0) setPage(restoredPage);
          if (result.data.length === 0) {
            pendingSidebarRestoreRef.current = null;
            consumeFattureReturnContextFromHistory();
          }
        }
        // Load stats + tab counts in parallel (pass all filter fields including amount/counterparty)
        const statsFilters = { direction: filters.direction, dateFrom: filters.dateFrom, dateTo: filters.dateTo, query: filters.query, amountMin: filters.amountMin, amountMax: filters.amountMax, counterpartyPattern: filters.counterpartyPattern };
        const [stats, inStats, outStats, aiSugCount] = await Promise.all([
          loadInvoiceStats(companyId, statsFilters),
          loadInvoiceStats(companyId, { ...statsFilters, direction: 'in' }),
          loadInvoiceStats(companyId, { ...statsFilters, direction: 'out' }),
          (() => { let q = supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('classification_status', 'ai_suggested'); if (directionFilter !== 'all') q = q.eq('direction', directionFilter); return q.then(r => r.count ?? 0); })(),
        ]);
        setServerStats(stats);
        setTabCounts({ in: inStats.total, out: outStats.total });
        setAiSuggestedCount(aiSugCount as number);
      } else {
        loadedPageRef.current = currentPage;
        setInvoices(prev => [...prev, ...result.data]);
      }
      setTotalCount(result.count);
      const loadedCount = reset ? result.data.length : ((currentPage + 1) * PAGE_SIZE);
      if (result.data.length < PAGE_SIZE || loadedCount >= result.count) setAllLoaded(true);
    } catch (e) { console.error('Errore:', e); }
    setLoadingList(false);
    setLoadingMore(false);
  }, [companyId, buildFilters, loadInvoicePagesUpTo, page]);

  // Initial load + reload when filters change
  useEffect(() => {
    if (!companyId) return;
    setPage(0); setAllLoaded(false); setInvoices([]); setTotalCount(0);
    reload(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, directionFilter, statusFilter, dateFrom, dateTo, debouncedQuery, aiResult?.candidateIds?.join(','), amountMin, amountMax, counterpartyPattern, aiSuggestedFilter, reloadTrigger]);

  // Load next page
  useEffect(() => {
    if (page <= loadedPageRef.current) return;
    reload(false);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [page]);

  useEffect(() => {
    const restoreContext = pendingSidebarRestoreRef.current;
    if (!restoreContext || loadingList || companyLoading || invoices.length === 0) return;

    let frame2 = 0;
    const frame1 = window.requestAnimationFrame(() => {
      frame2 = window.requestAnimationFrame(() => {
        const container = invoiceListScrollRef.current;
        if (!container) return;

        container.scrollTop = restoreContext.sidebarScrollTop;
        const row = invoiceRowRefs.current[restoreContext.selectedInvoiceId];
        if (row) {
          const visibleTop = container.scrollTop;
          const visibleBottom = visibleTop + container.clientHeight;
          const rowTop = row.offsetTop;
          const rowBottom = rowTop + row.offsetHeight;
          if (rowTop < visibleTop || rowBottom > visibleBottom) {
            row.scrollIntoView({ block: 'center' });
          }
        } else if (invoices.some(inv => inv.id === restoreContext.selectedInvoiceId)) {
          const fallbackRow = container.querySelector<HTMLElement>(`[data-invoice-id="${restoreContext.selectedInvoiceId}"]`);
          fallbackRow?.scrollIntoView({ block: 'center' });
        } else {
          return;
        }

        pendingSidebarRestoreRef.current = null;
        consumeFattureReturnContextFromHistory();
      });
    });

    return () => {
      window.cancelAnimationFrame(frame1);
      if (frame2) window.cancelAnimationFrame(frame2);
    };
  }, [invoices, loadingList, companyLoading]);

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    if (!bottomRef.current || allLoaded || loadingMore || loadingList) return;
    const observer = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) setPage(prev => prev + 1); },
      { threshold: 0.1 },
    );
    observer.observe(bottomRef.current);
    return () => observer.disconnect();
  }, [allLoaded, loadingMore, loadingList]);

  useEffect(() => { if (invoices.length > 0) loadExtractionStats(); }, [invoices.length, loadExtractionStats]);

  // Load classification metadata for sidebar icons
  useEffect(() => {
    if (!companyId || invoices.length === 0) return;
    let cancelled = false;
    const ids = invoices.map(inv => inv.id);
    loadInvoiceClassificationMeta(companyId, ids)
      .then(meta => { if (!cancelled) setClassifMeta(meta); })
      .catch(err => console.error('Classification meta error:', err));
    return () => { cancelled = true; };
  }, [companyId, invoices]);

  useEffect(() => {
    if (!selectedId || !companyId) {
      setDetailBundle(null);
      setDetailPhase('idle');
      return;
    }

    const cached = invoiceBundleCacheRef.current.get(selectedId);
    const requestToken = detailRequestTokenRef.current + 1;
    detailRequestTokenRef.current = requestToken;

    if (cached) {
      startTransition(() => {
        setDetailBundle(cached);
        setDetailPhase('ready');
      });
      return;
    }

    setDetailBundle(null);
    setDetailPhase('loading');

    loadCachedInvoiceBundle(selectedId)
      .then(bundle => {
        if (detailRequestTokenRef.current !== requestToken) return;
        startTransition(() => {
          setDetailBundle(bundle);
          setDetailPhase('ready');
        });
      })
      .catch(error => {
        if (detailRequestTokenRef.current !== requestToken) return;
        console.error('Invoice detail load error:', error);
        setDetailBundle(null);
        setDetailPhase('ready');
      });
  }, [selectedId, companyId, loadCachedInvoiceBundle]);

  useEffect(() => {
    const invoiceIdParam = searchParams.get('invoiceId');
    if (!invoiceIdParam || !companyId) return;

    // If already in current list, select it and clean up URL
    if (invoices.some(inv => inv.id === invoiceIdParam)) {
      handleSelectInvoice(invoiceIdParam);
      searchParams.delete('invoiceId');
      setSearchParams(searchParams, { replace: true });
      return;
    }

    // Invoice not in current list — might be in different direction tab or beyond page 1.
    // Fetch direction from DB, set selectedId immediately so detail panel loads,
    // and switch direction tab if needed.
    supabase
      .from('invoices')
      .select('id, direction')
      .eq('id', invoiceIdParam)
      .eq('company_id', companyId)
      .single()
      .then(({ data }) => {
        if (!data) return;
        // DB stores 'in' (passive) or 'out' (active) — same values as directionFilter
        const neededDir = data.direction as 'in' | 'out';
        // Set selectedId immediately so detail loading effect starts
        handleSelectInvoice(invoiceIdParam);
        if (neededDir !== directionFilter) {
          setDirectionFilter(neededDir);
          // Tab switch triggers reload → invoices update → effect re-runs → invoice found → URL cleaned
        }
      });
  }, [searchParams, invoices, companyId, directionFilter, handleSelectInvoice]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── AI Search handler — edge function handles all filtering server-side ──
  const handleAISearch = useCallback(async () => {
    if (!query.trim() || !companyId) return;
    setAiSearching(true); setAiError(''); setAiResult(null);
    resetAllFilters();
    try {
      const result = await askInvoiceAiSearch({
        query,
        company_id: companyId,
      });

      console.log('[Fatture AI] result:', JSON.stringify({ query_type: result.query_type, total: result.total, explanation: result.explanation?.slice(0, 80) }));

      const ids = result.ids || [];
      // Clear text query — AI handles filtering server-side via SQL
      setQuery('');
      clearTimeout(queryDebounceRef.current);
      setDebouncedQuery('');

      setAiResult({
        text: result.explanation || `Trovate ${result.total} fatture`,
        isError: false,
        requestId: result.request_id,
        // If 0 results, use nil UUID sentinel so .in('id', [...]) returns empty
        candidateIds: ids.length > 0 ? ids : ['00000000-0000-0000-0000-000000000000'],
        total: result.total,
      });
    } catch (e: any) {
      console.error('[Fatture AI] error:', e);
      const errText = [
        e.message || 'Errore ricerca AI',
        e.hint ? `Suggerimento: ${e.hint}` : '',
      ].filter(Boolean).join(' — ');
      setAiResult({ text: errText, isError: true });
    }
    setAiSearching(false);
  }, [query, companyId, resetAllFilters]);

  // Clear AI results + filters when query changes (user is typing)
  const handleQueryChange = (val: string) => {
    setQuery(val);
    if (aiResult) { setAiResult(null); resetAllFilters(); }
    if (aiError) setAiError('');
  };

  // Clear AI when direction changes
  useEffect(() => { setAiResult(null); setAiError(''); }, [directionFilter]);

  const handleImport = useCallback(async (files: FileList | File[]) => {
    if (!files.length) return;
    const fileArr = Array.from(files);
    setImporting(true); setImportPhase('reading'); setImportCurrent(0); setImportTotal(fileArr.length); setImportLogs([]);
    const parsed: any[] = [];
    for (let fi = 0; fi < fileArr.length; fi++) {
      const f = fileArr[fi];
      try {
        const results = await processInvoiceFile(f);
        for (const r of results) { parsed.push(r); if (r.err) setImportLogs(prev => [...prev, { fn: r.fn, status: 'error_parse', message: r.err }]); }
      } catch (e: any) { parsed.push({ fn: f.name, err: e.message }); setImportLogs(prev => [...prev, { fn: f.name, status: 'error_parse', message: e.message }]); }
      setImportCurrent(fi + 1);
    }
    let cid = companyId;
    const firstOk = parsed.find(r => !r.err && r.data);
    if (!cid && firstOk) {
      try { const eid = await ensureCompany(firstOk.data.ces); if (eid) cid = eid; await refetchCompany(); } catch {
        try { const eid = await ensureCompany(firstOk.data.ced); if (eid) cid = eid; await refetchCompany(); } catch {}
      }
    }
    if (!cid) { setImporting(false); return; }
    const okParsed = parsed.filter(r => !r.err && r.data);
    setImportPhase('saving'); setImportCurrent(0); setImportTotal(okParsed.length);
    await saveInvoicesToDB(cid, okParsed, (cur, tot, status, fn) => {
      setImportCurrent(cur); setImportTotal(tot);
      setImportLogs(prev => [...prev, { fn, status: status === 'ok' ? 'ok' : status === 'duplicate' ? 'duplicate' : 'error_save', message: status === 'error' ? 'Errore salvataggio' : undefined }]);
    });
    setImportPhase('done'); await reload(true); setTimeout(() => setImporting(false), 3000);

    // Auto-trigger reconciliation in background (fire-and-forget)
    const reconCid = companyId || company?.id
    if (okParsed.length > 0 && reconCid) {
      triggerAutoReconciliation(reconCid, {
        extractFirst: false,
        onComplete: () => { void refreshBadges() },
      })
    }
  }, [companyId, company?.id, ensureCompany, refetchCompany, reload, refreshBadges]);

  const handleDeleteConfirm = useCallback(async (_pw: string) => {
    const ids = deleteModal.ids; setDeleteModal({ open: false, ids: [] });
    try { await deleteInvoices(ids); } catch {}
    ids.forEach(id => invalidateInvoiceBundle(id));
    setChecked(new Set()); setSelectMode(false);
    if (ids.includes(selectedId || '')) setSelectedId(null);
    setPage(0); setAllLoaded(false); setInvoices([]);
    await reload(true);
  }, [deleteModal.ids, selectedId, reload, invalidateInvoiceBundle]);

  const handleEdit = useCallback(async (u: InvoiceUpdate) => {
    if (!selectedId) return;
    await updateInvoice(selectedId, u);
    invalidateInvoiceBundle(selectedId);
    await reload(true);
  }, [selectedId, reload, invalidateInvoiceBundle]);

  // Lightweight patch: update a single invoice in-place without full reload (preserves selection + scroll)
  const patchInvoice = useCallback((invoiceId: string, patch: Partial<DBInvoice>) => {
    setInvoices(prev => prev.map(inv => inv.id === invoiceId ? { ...inv, ...patch } : inv));
    // If classification_status changed away from ai_suggested, decrement count
    if (patch.classification_status && patch.classification_status !== 'ai_suggested') {
      setAiSuggestedCount(prev => Math.max(0, prev - 1));
    }
  }, []);

  // Filters are now server-side — `invoices` already contains filtered results

  const toggleCheck = (id: string) => setChecked(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selectAll = () => {
    const allC = invoices.length > 0 && invoices.every(i => checked.has(i.id));
    if (allC) setChecked(new Set());
    else setChecked(new Set(invoices.map(i => i.id)));
  };

  // ── Stats: from server-side counts + loaded data for amounts ──
  const stats = {
    total: serverStats?.total ?? totalCount,
    totalAmount: invoices.reduce((s, i) => s + (i.doc_type === 'TD04' ? -1 : 1) * i.total_amount, 0),
    daPagare: serverStats?.daPagare ?? invoices.filter(i => i.payment_status === 'pending').length,
    scadute: serverStats?.scadute ?? invoices.filter(i => i.payment_status === 'overdue').length,
    pagate: serverStats?.pagate ?? invoices.filter(i => i.payment_status === 'paid').length,
    counterparties: new Set(invoices.map(i => (i.counterparty as any)?.denom || i.source_filename)).size,
  };
  // Use invoice from list if available, otherwise fall back to detail loaded by ID
  // (handles deep-link case where invoice isn't in the visible page of results)
  const selectedInvoice = invoices.find(i => i.id === selectedId)
    ?? (selectedId && detailBundle?.invoiceId === selectedId && detailBundle.detail ? detailBundle.detail : null);
  const allFilteredChecked = invoices.length > 0 && invoices.every(i => checked.has(i.id));
  const navigateToCounterparty = useCallback((mode?: 'verify' | 'edit') => {
    const returnContext: FattureReturnContext | null = selectedInvoice ? {
      origin: 'invoice-counterparty',
      selectedInvoiceId: selectedInvoice.id,
      filters: {
        direction: directionFilter,
        status: statusFilter,
        aiSuggested: aiSuggestedFilter,
        dateFrom,
        dateTo,
        query,
        amountMin,
        amountMax,
        counterpartyPattern,
      },
      loadedPageIndex: loadedPageRef.current,
      sidebarScrollTop: invoiceListScrollRef.current?.scrollTop || 0,
    } : null;

    if (returnContext) {
      writeFattureReturnContext(returnContext);
    }

    if (selectedInvoice?.counterparty_id) {
      const params = new URLSearchParams({ counterpartyId: selectedInvoice.counterparty_id });
      if (mode) params.set('mode', mode);
      navigate(`/controparti?${params.toString()}`);
      return;
    }

    navigate('/controparti');
  }, [
    selectedInvoice,
    directionFilter,
    statusFilter,
    aiSuggestedFilter,
    dateFrom,
    dateTo,
    query,
    amountMin,
    amountMax,
    counterpartyPattern,
    navigate,
  ]);

  // ── Expose selected invoice to AI widget ──
  useEffect(() => {
    if (selectedInvoice) {
      const cpName = (selectedInvoice.counterparty as any)?.denom || 'N/D';
      const dir = selectedInvoice.direction === 'out' ? 'attiva/vendita' : 'passiva/acquisto';
      setPageEntity({
        type: 'invoice',
        id: selectedInvoice.id,
        summary: `Fattura N.${selectedInvoice.number} del ${fmtDate(selectedInvoice.date)} — ${cpName} — ${fmtEur(selectedInvoice.total_amount)} (${dir})`,
      });
    } else {
      setPageEntity(null);
    }
    return () => setPageEntity(null);
  }, [selectedInvoice, setPageEntity]);

  return (
    <div className="h-full flex flex-col bg-slate-100/40">
      <ConfirmDeleteModal open={deleteModal.open} count={deleteModal.ids.length} onConfirm={handleDeleteConfirm} onCancel={() => setDeleteModal({ open: false, ids: [] })} />
      {companyId && <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} companyId={companyId} companyName={company?.name || 'Azienda'} />}
      {/* Top bar */}
      <div className="flex items-center gap-4 px-6 py-3 bg-white/90 backdrop-blur-md border-b border-slate-200/80 shadow-sm flex-shrink-0 print:hidden z-20">
        <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-slate-900 to-slate-600 tracking-tight">Fatture</h1>
        {/* Segmented control Passive/Attive */}
        <div className="flex bg-slate-100/80 rounded-full p-1 border border-slate-200/50 shadow-inner">
          {([['in', 'Passive'], ['out', 'Attive']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setDirectionFilter(k)}
              className={`flex flex-col items-center px-6 py-1 text-xs rounded-full transition-all duration-200 ${
                directionFilter === k
                  ? 'bg-white text-slate-900 font-semibold shadow-sm ring-1 ring-slate-200/50'
                  : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
              }`}>
              <span>{label}</span>
              <span className="text-[10px] font-medium opacity-80">{tabCounts[k]}</span>
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {/* Inline stats */}
        <div className="flex items-center gap-2 text-xs text-slate-500 bg-white border border-slate-200/60 px-3 py-1.5 rounded-lg shadow-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" /><span>{stats.daPagare} {directionFilter === 'out' ? 'da incassare' : 'da pagare'}</span>
          <span className="text-slate-300 mx-1">|</span>
          <span className="w-1.5 h-1.5 rounded-full bg-red-400 inline-block" /><span>{stats.scadute} scadute</span>
          <span className="text-slate-300 mx-1">|</span>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" /><span>{stats.pagate} {directionFilter === 'out' ? 'incassate' : 'pagate'}</span>
          <span className="text-slate-300 mx-1">|</span>
          <span className="font-semibold text-slate-700 text-[13px]">{fmtEur(stats.totalAmount)}</span>
        </div>
        {/* Action buttons */}
        <button
          onClick={runBatchAiClassification}
          title={batchClassifRunning ? 'Ferma classificazione' : 'Classifica automaticamente categoria, conto e CdC'}
          className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
            batchClassifRunning
              ? 'text-red-700 bg-red-50 border-red-200 hover:bg-red-100'
              : 'text-indigo-600 bg-indigo-50 border-indigo-100 hover:bg-indigo-100'
          }`}
        >
          {batchClassifRunning
            ? <>{'\u23F9'} Stop ({batchClassifJobProgress.pct}%)</>
            : <>{'\u2728'} Classifica AI</>
          }
        </button>
        <button onClick={() => setExportOpen(true)} className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50">
          {'\u2193'} Export
        </button>
        <button onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-violet-500 text-white border border-violet-500 rounded-lg hover:bg-violet-600">+ Importa</button>
        <input ref={fileRef} type="file" multiple accept=".xml,.p7m,.zip" onChange={e => e.target.files && handleImport(e.target.files)} className="hidden" />
      </div>

      {importing && <div className="px-4 pt-3 print:hidden"><ImportProgress phase={importPhase} current={importCurrent} total={importTotal} logs={importLogs} /></div>}

      <div className="flex flex-1 overflow-hidden p-3 gap-3">
        {/* Sidebar */}
        <div className="w-[380px] border border-slate-200/60 shadow-sm rounded-xl bg-white/95 backdrop-blur-md flex flex-col flex-shrink-0 print:hidden z-10 overflow-hidden">
          <div className="p-3 border-b border-slate-100 bg-slate-50/50 space-y-2.5">
            {/* Search bar */}
            <div className="relative">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-xs">{'\uD83D\uDD0D'}</span>
              <input
                value={query}
                onChange={e => handleQueryChange(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && query.trim()) handleAISearch(); }}
                placeholder="Cerca fattura o controparte..."
                className="w-full pl-7 pr-12 py-2 text-xs border border-slate-200 rounded-lg bg-white outline-none focus:ring-1 focus:ring-slate-300"
              />
              <button
                onClick={handleAISearch}
                disabled={aiSearching || !query.trim()}
                title="Ricerca AI"
                className={`absolute right-1.5 top-1/2 -translate-y-1/2 px-2 py-1 text-[10px] font-semibold rounded-md transition-all ${aiSearching ? 'bg-violet-100 text-violet-600 animate-pulse' : 'bg-violet-50 text-violet-600 hover:bg-violet-100 disabled:opacity-40'}`}
              >
                AI {'\u2728'}
              </button>
            </div>

            {/* AI search result — explanation for success, error for failures */}
            {aiResult && (aiResult.isError ? (
              <div className="flex items-center gap-1.5 px-2 py-1 bg-red-50 border border-red-200 rounded-lg">
                <span className="text-[10px] text-red-600 flex-1">⚠ {aiResult.text}</span>
                <button onClick={() => { setAiResult(null); resetAllFilters(); }} className="text-red-400 hover:text-red-600 text-xs font-bold">✕</button>
              </div>
            ) : aiResult.text ? (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-violet-50 border border-violet-200 rounded-lg">
                <span className="text-[11px] text-violet-700 flex-1">✨ {aiResult.text} — <strong>{aiResult.total ?? 0}</strong> risultati</span>
                <button onClick={() => { setAiResult(null); resetAllFilters(); }} className="text-violet-400 hover:text-violet-600 text-xs font-bold">✕</button>
              </div>
            ) : null)}
            {aiError && (
              <div className="flex items-center gap-1.5 px-2 py-1 bg-red-50 border border-red-200 rounded-lg">
                <span className="text-[10px] text-red-600 flex-1">⚠ {aiError}</span>
                <button onClick={() => setAiError('')} className="text-red-400 hover:text-red-600 text-xs font-bold">✕</button>
              </div>
            )}

            {/* Date range filter */}
            <div className="flex gap-1.5 items-center">
              <label className="text-[10px] text-gray-500 font-medium w-6">Dal</label>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="flex-1 px-1.5 py-1 text-[11px] border rounded bg-gray-50 outline-none focus:ring-1 focus:ring-sky-400" />
              <label className="text-[10px] text-gray-500 font-medium w-5">Al</label>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="flex-1 px-1.5 py-1 text-[11px] border rounded bg-gray-50 outline-none focus:ring-1 focus:ring-sky-400" />
              {(dateFrom || dateTo) && (
                <button onClick={() => { setDateFrom(''); setDateTo(''); }} className="text-gray-400 hover:text-gray-600 text-xs font-bold" title="Azzera date">✕</button>
              )}
            </div>

            {/* Status filter */}
            <div className="flex gap-1">
              {(['all', 'pending', 'overdue', 'paid'] as const).map(s => (
                <button key={s} onClick={() => { setStatusFilter(s); setAiSuggestedFilter(false); }} className={`flex-1 py-1 text-[10px] font-semibold rounded ${statusFilter === s && !aiSuggestedFilter ? 'bg-sky-100 text-sky-700 border border-sky-300' : 'bg-gray-50 text-gray-500 border border-gray-200'}`}>{s === 'all' ? 'Tutte' : getStatusLabel(s, directionFilter)}</button>
              ))}
            </div>
            {/* AI classification filter */}
            {aiSuggestedCount > 0 && (
              <button
                onClick={() => { setAiSuggestedFilter(f => !f); setStatusFilter('all'); }}
                className={`w-full py-1.5 text-[11px] font-semibold rounded-md transition-colors ${
                  aiSuggestedFilter
                    ? 'bg-amber-100 text-amber-700 border border-amber-300'
                    : 'bg-amber-50 text-amber-600 border border-amber-200 hover:bg-amber-100'
                }`}
              >
                ⚡ Da Confermare ({aiSuggestedCount})
              </button>
            )}
            <div className="flex items-center gap-2">
              <button onClick={() => { setSelectMode(!selectMode); if (selectMode) setChecked(new Set()); }} className={`px-2 py-1 text-[10px] font-semibold rounded ${selectMode ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{selectMode ? '✕ Esci Selezione' : '☐ Seleziona'}</button>
              {selectMode && <>
                <button onClick={selectAll} className="px-2 py-1 text-[10px] font-semibold bg-gray-100 text-gray-600 rounded hover:bg-gray-200">{allFilteredChecked ? 'Deseleziona tutte' : 'Seleziona tutte'}</button>
                {checked.size > 0 && <button onClick={() => setDeleteModal({ open: true, ids: Array.from(checked) })} className="px-2 py-1 text-[10px] font-semibold bg-red-600 text-white rounded hover:bg-red-700">🗑 Elimina {checked.size}</button>}
              </>}
            </div>
          </div>
	          <div ref={invoiceListScrollRef} className="flex-1 overflow-y-auto">
	            {loadingList || companyLoading ? <div className="text-center py-8 text-gray-400 text-sm">Caricamento...</div>
	              : invoices.length === 0 ? <div className="text-center py-8 text-gray-400 text-sm">Nessun risultato</div>
	              : <>
	                {invoices.map(inv => <InvoiceCard key={inv.id} inv={inv} selected={selectedId === inv.id} checked={checked.has(inv.id)} selectMode={selectMode} onSelect={() => handleSelectInvoice(inv.id)} onCheck={() => toggleCheck(inv.id)} onPrefetch={() => prefetchInvoiceBundle(inv.id)} isMatched={matchedInvoiceIds.has(inv.id)} suggestionScore={invoiceScores.get(inv.id)} meta={classifMeta.get(inv.id)} rowRef={(node) => { invoiceRowRefs.current[inv.id] = node; }} />)}
	                {!allLoaded && <div ref={bottomRef} className="py-4 text-center text-xs text-gray-400">{loadingMore ? 'Caricamento...' : ''}</div>}
	              </>}
	          </div>
        </div>
        {/* Detail */}
        <div className="flex-1 flex flex-col overflow-hidden bg-white/95 backdrop-blur-md border border-slate-200/60 shadow-sm rounded-xl">
          {selectedInvoice ? <InvoiceDetail
            invoice={selectedInvoice}
            detailBundle={detailBundle}
            detailPhase={detailPhase}
            referenceData={referenceData}
            referenceDataLoading={referenceDataLoading}
            onInvalidateBundle={invalidateInvoiceBundle}
            onEdit={handleEdit}
            onDelete={() => setDeleteModal({ open: true, ids: [selectedInvoice.id] })}
            onReload={reload}
	            onPatchInvoice={patchInvoice}
	            onRefreshBadges={refreshClassifMeta}
	            onSetClassifMeta={setInvoiceClassifMeta}
	            onOpenCounterparty={(mode: 'verify' | 'edit') => navigateToCounterparty(mode)}
	            onOpenScadenzario={() => {
	              const tab = selectedInvoice.direction === 'out' ? 'incassi' : 'pagamenti';
	              const q = encodeURIComponent(selectedInvoice.number || '');
	              navigate(`/scadenzario?tab=${tab}&period=all&status=all&invoiceId=${selectedInvoice.id}&query=${q}`);
	            }}
	            onNavigateCounterparty={() => navigateToCounterparty()}
	          />
            : <div className="flex items-center justify-center h-full text-gray-400 text-sm">Seleziona una fattura dalla lista</div>}
        </div>
      </div>
    </div>
  );
}
