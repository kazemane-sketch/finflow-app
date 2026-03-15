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

function buildConsultantStarterMessage(alert: FiscalAlert): string {
  if (alert.options?.length) {
    return `Partiamo dal punto chiave: ${alert.title}. Mi basta una conferma breve per sbloccarlo. Scegli una risposta rapida qui sotto oppure scrivimi il dettaglio mancante.`
  }
  return `Partiamo dal punto chiave: ${alert.title}. Dimmi solo il dettaglio utile per decidere, senza fare un riepilogo lungo.`
}

function isGenericConsultantMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return [
    'approfondiamo',
    'approfondisci',
    'parliamone',
    'parliamo',
    'spiegami meglio',
    'dimmi di più',
    'dimmi di piu',
    'aiutami',
  ].includes(normalized)
}

function buildConsultantApiMessage(text: string, alert: FiscalAlert | null, hasPriorUserMessages: boolean): string {
  if (!alert) return text

  const trimmed = text.trim()
  if (!hasPriorUserMessages && isGenericConsultantMessage(trimmed)) {
    return [
      `Vai subito al punto sul dubbio aperto: ${alert.title}.`,
      `Contesto: ${alert.description}`,
      'Non fare un riepilogo lungo della fattura.',
      'Fai una sola domanda decisiva oppure proponi fino a 3 opzioni brevi e concrete.',
    ].join(' ')
  }

  if (!hasPriorUserMessages && /^confermo:/i.test(trimmed)) {
    return [
      `Per il dubbio "${alert.title}" confermo questa informazione: ${trimmed.replace(/^confermo:\s*/i, '')}.`,
      'Valuta se ora puoi formulare una proposta applicabile; se non basta, chiedi solo il prossimo dato mancante.',
    ].join(' ')
  }

  return text
}
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

import { buildAggregatedNotes, hasAnyLineProjects, EMPTY_INVOICE_CLASSIF_META, type PendingFiscalChoice, type InvoiceDetailPhase, type InvoiceLineArticleAssignmentRow, type InvoiceDetailBundle, type InvoiceReferenceData } from '@/pages/FatturePage';

export function InvoiceDetail({ invoice, detailBundle, detailPhase, referenceData, referenceDataLoading, onInvalidateBundle, onEdit, onDelete, onReload, onPatchInvoice, onRefreshBadges, onSetClassifMeta, onOpenCounterparty, onOpenScadenzario, onNavigateCounterparty }: {
  invoice: DBInvoice;
  detailBundle: InvoiceDetailBundle | null;
  detailPhase: InvoiceDetailPhase;
  referenceData: InvoiceReferenceData;
  referenceDataLoading: boolean;
  onInvalidateBundle: (invoiceId: string) => void;
  onEdit: (u: InvoiceUpdate) => Promise<void>; onDelete: () => void; onReload: () => void;
  onPatchInvoice: (invoiceId: string, patch: Partial<DBInvoice>) => void;
  onRefreshBadges: (invoiceId: string) => void;
  onSetClassifMeta: (invoiceId: string, meta: InvoiceClassificationMeta | null) => void;
  onOpenCounterparty: (mode: 'verify' | 'edit') => void;
  onOpenScadenzario: () => void;
  onNavigateCounterparty: () => void;
}) {
  const { company } = useCompany();
  const activeDetailBundle = detailBundle?.invoiceId === invoice.id ? detailBundle : null;
  const detail = activeDetailBundle?.detail ?? null;
  const installments = activeDetailBundle?.installments ?? [];
  const [activeTab, setActiveTab] = useState<DetailTab>('dettaglio');
  const [editing, setEditing] = useState(false);
  const [showXml, setShowXml] = useState(false);
  const [parsed, setParsed] = useState<any>(null);
  // Notes tab state
  const [notesText, setNotesText] = useState(invoice.notes || '');
  const [notesSaving, setNotesSaving] = useState(false);
  // AI banner + consultant chat state
  const [aiBannerStatus, setAiBannerStatus] = useState<BannerStatus>('idle');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatAlertContext, setChatAlertContext] = useState('');
  const [chatLineIds, setChatLineIds] = useState<string[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [proposedConsultantAction, setProposedConsultantAction] = useState<ConsultantAction | null>(null);
  const [activeConsultAlert, setActiveConsultAlert] = useState<FiscalAlert | null>(null);
  // Inline note editing in flat table
  const [editingNoteLineId, setEditingNoteLineId] = useState<string | null>(null);
  const [editingNoteText, setEditingNoteText] = useState('');
  const handleSaveLineNote = useCallback(async (lineId: string, note: string) => {
    const { error } = await supabase
      .from('invoice_lines')
      .update({
        line_note: note,
        line_note_source: 'user',
        line_note_updated_at: new Date().toISOString(),
      })
      .eq('id', lineId);
    if (error) toast.error('Errore salvataggio nota');
    else toast.success('Nota salvata');
  }, []);

  // ─── Chat with unified invoice consultant ─────────────────────────
  const handleStartChat = useCallback((alert: FiscalAlert) => {
    setActiveConsultAlert(alert);
    setChatAlertContext(`${alert.title}: ${alert.description}`);
    setChatLineIds(alert.affected_lines || []);
    setChatMessages([{
      role: 'assistant',
      content: buildConsultantStarterMessage(alert),
    }]);
    setProposedConsultantAction(null);
    setAiBannerStatus('consulting');
  }, []);

  const handleSendChatMessage = useCallback(async (text: string) => {
    const visibleMessages: ChatMessage[] = [...chatMessages, { role: 'user', content: text }];
    const hasPriorUserMessages = chatMessages.some((message) => message.role === 'user');
    const apiMessages: ChatMessage[] = [...chatMessages, {
      role: 'user',
      content: buildConsultantApiMessage(text, activeConsultAlert, hasPriorUserMessages),
    }];
    setChatMessages(visibleMessages);
    setChatLoading(true);
    try {
      const data = await invokeAiAssistant({
        mode: 'invoice_consultant',
        invoice_id: invoice.id,
        line_ids: chatLineIds,
        alert_context: chatAlertContext,
        messages: apiMessages,
        company_id: company?.id,
      }, {
        requireUserAuth: false,
      }) as {
        message?: string
        action?: ConsultantAction
        debug?: PipelineStepDebug
      };

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: data.message || 'Nessuna risposta disponibile.',
        action: data.action || undefined,
      };
      setChatMessages([...visibleMessages, assistantMessage]);
      if (data.debug?.step === 'consultant') {
        setPipelineDebug(prev => {
          const base = Array.isArray(prev) ? prev.filter(step => step.step !== 'consultant') : [];
          return [...base, data.debug as PipelineStepDebug];
        });
      }
      if (data.action?.type === 'apply_consultant_resolution' || data.action?.type === 'apply_fiscal_override') {
        setProposedConsultantAction(data.action as ConsultantAction);
        setAiBannerStatus('proposed');
      } else {
        setAiBannerStatus('consulting');
      }
    } catch (e: any) {
      toast.error('Errore Assistente AI: ' + (e.message || 'sconosciuto'));
      setChatMessages([...visibleMessages, { role: 'assistant', content: 'Mi dispiace, si è verificato un errore. Riprova.' }]);
    } finally {
      setChatLoading(false);
    }
  }, [chatMessages, chatLineIds, chatAlertContext, invoice.id, company?.id, activeConsultAlert]);

  const handleConsultantQuickReply = useCallback((option: FiscalAlertOption) => {
    void handleSendChatMessage(`Confermo: ${option.label}`);
  }, [handleSendChatMessage]);

  const handleApplyConsultantAction = useCallback(async (action: ConsultantAction) => {
    if (action.type === 'apply_fiscal_override' && action.affected_line_ids?.length) {
      const affectedLineIds = action.affected_line_ids || [];
      setLineFiscalFlags(prev => {
        const updated = { ...prev };
        for (const lid of affectedLineIds) {
          updated[lid] = { ...(updated[lid] || {}), ...action.fiscal_override };
        }
        return updated;
      });
      // Save note on affected lines
      for (const lid of affectedLineIds) {
        if (action.note) {
          handleSaveLineNote(lid, action.note);
        }
      }
      setClassifDirty(true);
      setProposedConsultantAction(action);
      setAiBannerStatus('applied');
      toast.success('Decisione fiscale applicata');
      return;
    }
    if (action.type === 'apply_consultant_resolution' && company?.id && action.line_updates?.length) {
      try {
        const { resolvedUpdates } = await applyConsultantResolution(company.id, invoice.id, {
          invoice_line_ids: action.line_updates.map(update => update.line_id),
          message_excerpt: chatMessages[chatMessages.length - 1]?.content || null,
          recommended_conclusion: action.recommended_conclusion || null,
          rationale_summary: action.rationale_summary || action.reasoning || action.note || null,
          risk_level: action.risk_level || 'medium',
          supporting_evidence: (action.supporting_evidence || []).map((evidence): SupportingEvidence => ({
            source: ['kb', 'memory', 'deterministic', 'reviewer', 'consultant', 'company_stats', 'invoice', 'history', 'user'].includes(evidence.source)
              ? evidence.source as SupportingEvidence['source']
              : 'consultant',
            label: evidence.label,
            detail: evidence.detail ?? null,
            ref: evidence.ref ?? null,
          })),
          expected_impact: action.expected_impact || null,
          decision_basis: ['consultant_resolution'],
          supporting_factors: action.reasoning ? [action.reasoning] : [],
          decision_patch: {
            line_updates: action.line_updates,
          },
          source_payload: action as unknown as Record<string, unknown>,
          line_updates: action.line_updates,
        });

        setLineClassifs(prev => {
          const updated = { ...prev };
          for (const lineUpdate of resolvedUpdates) {
            updated[lineUpdate.line_id] = {
              invoice_line_id: lineUpdate.line_id,
              category_id: lineUpdate.category_id ?? prev[lineUpdate.line_id]?.category_id ?? null,
              account_id: lineUpdate.account_id ?? prev[lineUpdate.line_id]?.account_id ?? null,
            };
          }
          return updated;
        });
        setLineFiscalFlags(prev => {
          const updated = { ...prev };
          for (const lineUpdate of resolvedUpdates) {
            if (lineUpdate.fiscal_flags !== undefined) updated[lineUpdate.line_id] = lineUpdate.fiscal_flags || {};
          }
          return updated;
        });
        setLineConfidences(prev => {
          const updated = { ...prev };
          for (const lineUpdate of action.line_updates || []) {
            if (lineUpdate.final_confidence != null) updated[lineUpdate.line_id] = lineUpdate.final_confidence;
          }
          return updated;
        });
        setLineReviewFlags(prev => {
          const updated = { ...prev };
          for (const lineUpdate of action.line_updates || []) {
            updated[lineUpdate.line_id] = (lineUpdate.decision_status || 'finalized') !== 'finalized';
          }
          return updated;
        });
        setLineDetails(prev => {
          const updated = { ...prev };
          for (const lineUpdate of action.line_updates || []) {
            updated[lineUpdate.line_id] = {
              ...(updated[lineUpdate.line_id] || {
                classification_reasoning: null,
                classification_thinking: null,
                fiscal_reasoning: null,
                fiscal_thinking: null,
                fiscal_confidence: null,
                reasoning_summary_final: null,
                decision_status: null,
                final_confidence: null,
                final_decision_source: null,
                line_note: null,
                line_note_source: null,
                line_note_updated_at: null,
              }),
              reasoning_summary_final: lineUpdate.reasoning_summary_final || action.rationale_summary || updated[lineUpdate.line_id]?.reasoning_summary_final || null,
              decision_status: lineUpdate.decision_status || 'finalized',
              final_confidence: lineUpdate.final_confidence ?? updated[lineUpdate.line_id]?.final_confidence ?? null,
              final_decision_source: 'consulente',
              line_note: lineUpdate.note ?? updated[lineUpdate.line_id]?.line_note ?? null,
              line_note_source: lineUpdate.note ? 'ai_consultant' : updated[lineUpdate.line_id]?.line_note_source ?? null,
              line_note_updated_at: lineUpdate.note ? new Date().toISOString() : updated[lineUpdate.line_id]?.line_note_updated_at ?? null,
            };
          }
          return updated;
        });

        setClassifDirty(true);
        setProposedConsultantAction(action);
        setAiBannerStatus('applied');
        onInvalidateBundle(invoice.id);
        toast.success('Risoluzione del consulente applicata');
      } catch (e: any) {
        toast.error(`Errore applicazione consulente: ${e.message || 'sconosciuto'}`);
      }
    }
  }, [chatMessages, company?.id, handleSaveLineNote, invoice.id, onInvalidateBundle]);

  const handleKeepCurrentDecision = useCallback(() => {
    setAiBannerStatus('done');
    toast.success('Decisione corrente mantenuta');
  }, []);

  const handleAskConsultantFollowUp = useCallback(() => {
    setAiBannerStatus('consulting');
  }, []);

  // Required note dialog for non-conservative fiscal choices
  const [requiredNoteDialog, setRequiredNoteDialog] = useState<{
    alertIdx: number;
    option: FiscalAlertOption;
    suggestedNote: string;
  } | null>(null);
  const requiredNoteTextRef = useRef('');

  const notesDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [counterpartyHeaderInfo, setCounterpartyHeaderInfo] = useState<{ atecoDescription: string | null; provinceSigla: string | null; status: 'pending' | 'verified' | 'rejected' | null }>({
    atecoDescription: null,
    provinceSigla: extractProvinceSiglaFromAddress((invoice.counterparty as any)?.sede || null),
    status: null,
  });

  // ─── Article assignment state ───
  const [articles, setArticles] = useState<ArticleWithPhases[]>(referenceData.articles);
  const [lineArticleMap, setLineArticleMap] = useState<Record<string, LineArticleInfo>>({});
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, MatchResult>>({});
  // Track dismissed AI article suggestions — triggers dirty state so Salva persists the removal
  const [dismissedArticleLineIds, setDismissedArticleLineIds] = useState<Set<string>>(new Set());

  // ─── Classification state ───
  const [allCategories, setAllCategories] = useState<Category[]>(referenceData.categories);
  const [allProjects, setAllProjects] = useState<Project[]>(referenceData.projects);
  const [allAccounts, setAllAccounts] = useState<ChartAccount[]>(referenceData.accounts);
  const [classification, setClassification] = useState<InvoiceClassification | null>(null);
  const [invProjects, setInvProjects] = useState<InvoiceProjectAssignment[]>([]);
  const [selCategoryId, setSelCategoryId] = useState<string | null>(null);
  const [selAccountId, setSelAccountId] = useState<string | null>(null);
  const [classifDirty, setClassifDirty] = useState(false);
  const [classifSaving, setClassifSaving] = useState(false);

  // ─── Direction-filtered categories & accounts ───
  // Primary sections for each direction (mirrored from edge function constants)
  const DIR_SECTIONS: Record<string, { primary: CoaSection[]; allowed: CoaSection[] }> = {
    in:  { primary: ['cost_production','cost_personnel','depreciation','other_costs'],
           allowed: ['cost_production','cost_personnel','depreciation','other_costs','financial','extraordinary','assets','liabilities','equity'] },
    out: { primary: ['revenue'],
           allowed: ['revenue','financial','extraordinary','assets','liabilities','equity'] },
  };
  const DIR_CAT_TYPES: Record<string, CategoryType[]> = {
    in:  ['expense', 'both'],
    out: ['revenue', 'both'],
  };

  const dir = invoice?.direction || 'in';
  const dirCatTypes = DIR_CAT_TYPES[dir] || DIR_CAT_TYPES['in'];
  const dirSections = DIR_SECTIONS[dir] || DIR_SECTIONS['in'];

  // Categories filtered by direction for dropdowns
  const dirCategories = useMemo(() =>
    allCategories.filter(c => dirCatTypes.includes(c.type)),
    [allCategories, dir],
  );
  const otherCategories = useMemo(() =>
    allCategories.filter(c => !dirCatTypes.includes(c.type)),
    [allCategories, dir],
  );

  // Accounts split: primary (main section) + secondary (allowed edge cases) + other (wrong direction)
  const dirPrimaryAccounts = useMemo(() =>
    allAccounts.filter(a => dirSections.primary.includes(a.section)),
    [allAccounts, dir],
  );
  const dirSecondaryAccounts = useMemo(() =>
    allAccounts.filter(a => dirSections.allowed.includes(a.section) && !dirSections.primary.includes(a.section)),
    [allAccounts, dir],
  );
  const dirOtherAccounts = useMemo(() =>
    allAccounts.filter(a => !dirSections.allowed.includes(a.section)),
    [allAccounts, dir],
  );

  // Helper: check if a selected category/account is incompatible with direction
  const isCategoryMismatch = useCallback((catId: string | null) => {
    if (!catId) return false;
    const cat = allCategories.find(c => c.id === catId);
    return cat ? !dirCatTypes.includes(cat.type) : false;
  }, [allCategories, dir]);
  const isAccountMismatch = useCallback((accId: string | null) => {
    if (!accId) return false;
    const acc = allAccounts.find(a => a.id === accId);
    return acc ? !dirSections.allowed.includes(acc.section) : false;
  }, [allAccounts, dir]);

  // Multi-CdC state: local editable rows with percentage/amount toggle
  type CdcMode = 'percentage' | 'amount';
  type CdcRow = { project_id: string; percentage: number; amount: number | null };
  const [cdcMode, setCdcMode] = useState<CdcMode>('percentage');
  const [cdcRows, setCdcRows] = useState<CdcRow[]>([]);
  const [addCdcId, setAddCdcId] = useState('');
  // Line-level classification overrides (category + account per line)
  const [lineClassifs, setLineClassifs] = useState<Record<string, LineClassification>>({});
  // Line-level CdC allocations (per line)
  const [lineProjects, setLineProjects] = useState<Record<string, LineProjectAssignment[]>>({});
  const [cdcPopoverLineId, setCdcPopoverLineId] = useState<string | null>(null);
  const [cdcPopoverPos, setCdcPopoverPos] = useState<{ top: number; left: number | undefined; right: number | undefined }>({ top: 0, left: 0, right: undefined });
  const cdcPopoverRef = useRef<HTMLDivElement>(null);

  // Close CdC popover on outside click
  useEffect(() => {
    if (!cdcPopoverLineId) return;
    const handler = (e: MouseEvent) => {
      if (cdcPopoverRef.current?.contains(e.target as Node)) return;
      setCdcPopoverLineId(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [cdcPopoverLineId]);

  // AI classification suggestion state
  const [aiClassifStatus, setAiClassifStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [aiClassifResult, setAiClassifResult] = useState<any>(null);
  const activeInvoiceIdRef = useRef(invoice.id);
  const mountedRef = useRef(true);
  const primaryContractRef = useMemo(() => extractPrimaryContractRef(detail?.raw_xml), [detail?.raw_xml]);
  // Rules dialog: when rules match, show choice before running AI
  const [showRulesDialog, setShowRulesDialog] = useState(false);
  const [pendingRuleSuggestions, setPendingRuleSuggestions] = useState<RuleSuggestion[]>([]);
  const [lineFiscalFlags, setLineFiscalFlags] = useState<Record<string, any>>({});
  // AI confidence + review flags per line (for "Da revisionare" badges)
  const [lineConfidences, setLineConfidences] = useState<Record<string, number>>({});
  const [lineReviewFlags, setLineReviewFlags] = useState<Record<string, boolean>>({});
  // Line action metadata (skip/group informational lines)
  const [lineActions, setLineActions] = useState<Record<string, LineActionMeta>>({});
  const [lineDetails, setLineDetails] = useState<Record<string, LineDetailData>>({});
  // Fiscal review alerts from Sonnet escalation
  const [invoiceNotes, setInvoiceNotes] = useState<FiscalAlert[]>([]);
  const [pendingFiscalChoices, setPendingFiscalChoices] = useState<PendingFiscalChoice[]>([]);
  const [pipelineDebug, setPipelineDebug] = useState<PipelineStepDebug[] | null>(null);
  const resolveInvoiceAlertIndex = useCallback((alertId: string) => {
    const indexedPrefix = 'alert-';
    if (alertId.startsWith(indexedPrefix)) {
      const parsedIdx = Number.parseInt(alertId.slice(indexedPrefix.length), 10);
      if (Number.isFinite(parsedIdx) && parsedIdx >= 0 && parsedIdx < invoiceNotes.length) return parsedIdx;
    }

    return invoiceNotes.findIndex((alert, index) => {
      const runtimeId = (alert as FiscalAlert & { id?: string }).id;
      return runtimeId === alertId || `${indexedPrefix}${index}` === alertId;
    });
  }, [invoiceNotes]);
  // AI suggestion state for new accounts/categories
  const [lineSuggestions, setLineSuggestions] = useState<Record<string, {
    suggest_new_account?: AccountSuggestion | null;
    suggest_new_category?: CategorySuggestion | null;
  }>>({});
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(new Set());
  const [creatingSuggestion, setCreatingSuggestion] = useState<string | null>(null);
  // Bulk article + phase selection
  const [bulkArticleId, setBulkArticleId] = useState<string | null>(null);
  const [bulkPhaseId, setBulkPhaseId] = useState<string | null>(null);
  // Original snapshots for dirty-state tracking on confirmed invoices
  const [originalLineClassifs, setOriginalLineClassifs] = useState<Record<string, LineClassification>>({});
  const [originalLineArticleMap, setOriginalLineArticleMap] = useState<Record<string, LineArticleInfo>>({});
  const [confirmChangesSaving, setConfirmChangesSaving] = useState(false);
  // Clipboard for copy/paste classification between lines
  const [copiedClassif, setCopiedClassif] = useState<{
    category_id: string | null;
    account_id: string | null;
    projects: { project_id: string; percentage: number }[];
  } | null>(null);
  // Clear all classification dialog
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [clearPending, setClearPending] = useState(false);
  // Original line CdC snapshot for dirty-state tracking
  const [originalLineProjects, setOriginalLineProjects] = useState<Record<string, LineProjectAssignment[]>>({});
  const [originalInvoiceProjects, setOriginalInvoiceProjects] = useState<InvoiceProjectAssignment[]>([]);
  const [originalClassificationSnapshot, setOriginalClassificationSnapshot] = useState<{ category_id: string | null; account_id: string | null }>({
    category_id: null,
    account_id: null,
  });
  // Hide zero-amount lines toggle
  const [showZeroLines, setShowZeroLines] = useState(false);
  const isConfirmed = invoice.classification_status === 'confirmed';
  const counterpartyAddressFallback = useMemo(() => {
    const cp = (invoice.counterparty || {}) as any;
    return cp?.sede || null;
  }, [invoice.counterparty]);
  const singleInvoiceJobLabel = useMemo(() => {
    const cp = (invoice.counterparty || {}) as any;
    const idPart = invoice.number ? `Fatt. ${invoice.number}` : `Fattura ${invoice.id.slice(0, 8)}`;
    return cp?.denom ? `Classificazione AI · ${idPart} · ${cp.denom}` : `Classificazione AI · ${idPart}`;
  }, [invoice.id, invoice.number, invoice.counterparty]);
  const {
    job: singleInvoiceJob,
    isRunning: singleInvoiceJobRunning,
    progress: singleInvoiceJobProgress,
    start: startSingleInvoiceJob,
    stop: stopSingleInvoiceJob,
  } = useAIJob('fatture-classify-single', singleInvoiceJobLabel, { instanceKey: invoice.id });

  useEffect(() => {
    activeInvoiceIdRef.current = invoice.id;
  }, [invoice.id]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Safety net: if job finished but aiClassifStatus is still 'loading', reset it
  useEffect(() => {
    if (!singleInvoiceJobRunning && aiClassifStatus === 'loading' && singleInvoiceJob && singleInvoiceJob.status !== 'running') {
      setAiClassifStatus(singleInvoiceJob.status === 'completed' ? 'done' : 'error');
    }
  }, [singleInvoiceJobRunning, aiClassifStatus, singleInvoiceJob]);

  useEffect(() => {
    const fallbackProvince = extractProvinceSiglaFromAddress(counterpartyAddressFallback);
    if (!invoice.counterparty_id) {
      setCounterpartyHeaderInfo({ atecoDescription: null, provinceSigla: fallbackProvince, status: null });
      return;
    }

    let cancelled = false;
    setCounterpartyHeaderInfo(prev => ({ ...prev, provinceSigla: fallbackProvince }));

    loadCounterpartyHeaderInfo(invoice.counterparty_id)
      .then(info => {
        if (cancelled) return;
        setCounterpartyHeaderInfo({
          atecoDescription: info.atecoDescription,
          provinceSigla: info.provinceSigla || fallbackProvince,
          status: info.status,
        });
      })
      .catch(err => {
        if (cancelled) return;
        console.warn('[invoice-detail] counterparty header info error:', err);
        setCounterpartyHeaderInfo({ atecoDescription: null, provinceSigla: fallbackProvince, status: null });
      });

    return () => { cancelled = true; };
  }, [invoice.counterparty_id, counterpartyAddressFallback]);

  useEffect(() => {
    if (!singleInvoiceJob) return;
    if (singleInvoiceJob.status === 'running') {
      setAiClassifStatus('loading');
      return;
    }
    if (singleInvoiceJob.status === 'failed') {
      setAiClassifStatus('error');
      return;
    }
    if (singleInvoiceJob.status === 'cancelled') {
      setAiClassifStatus(prev => prev === 'loading' ? 'idle' : prev);
    }
  }, [singleInvoiceJob]);

  // Dirty state: any line classification, article, or CdC changed vs originals
  const isPostConfirmDirty = useMemo(() => {
    // Check dismissed AI article suggestions (need saving to delete from DB)
    if (dismissedArticleLineIds.size > 0) return true;
    if (pendingFiscalChoices.length > 0) return true;
    // Check line classifications changed
    const lcKeys = new Set([...Object.keys(lineClassifs), ...Object.keys(originalLineClassifs)]);
    for (const k of lcKeys) {
      const curr = lineClassifs[k];
      const orig = originalLineClassifs[k];
      if (curr?.category_id !== orig?.category_id || curr?.account_id !== orig?.account_id) return true;
    }
    // Check article assignments changed
    const artKeys = new Set([...Object.keys(lineArticleMap), ...Object.keys(originalLineArticleMap)]);
    for (const k of artKeys) {
      const curr = lineArticleMap[k];
      const orig = originalLineArticleMap[k];
      if (!curr && !orig) continue;
      if (!curr || !orig) return true;
      if (curr.article_id !== orig.article_id || curr.phase_id !== orig.phase_id) return true;
    }
    // Check line-level CdC changed
    const projKeys = new Set([...Object.keys(lineProjects), ...Object.keys(originalLineProjects)]);
    for (const k of projKeys) {
      const curr = (lineProjects[k] || []).map(p => `${p.project_id}:${p.percentage}`).sort().join(',');
      const orig = (originalLineProjects[k] || []).map(p => `${p.project_id}:${p.percentage}`).sort().join(',');
      if (curr !== orig) return true;
    }
    // Also check invoice-level dirty (CdC etc.)
    return classifDirty;
  }, [dismissedArticleLineIds, pendingFiscalChoices, lineClassifs, originalLineClassifs, lineArticleMap, originalLineArticleMap, lineProjects, originalLineProjects, classifDirty]);

  const persistedHasData = useMemo(() => (
    !!originalClassificationSnapshot.category_id
    || !!originalClassificationSnapshot.account_id
    || Object.keys(originalLineClassifs).length > 0
    || Object.keys(originalLineArticleMap).length > 0
    || hasAnyLineProjects(originalLineProjects)
    || originalInvoiceProjects.length > 0
  ), [originalClassificationSnapshot, originalLineClassifs, originalLineArticleMap, originalLineProjects, originalInvoiceProjects]);

  const draftHasData = useMemo(() => (
    !!classification
    || Object.keys(lineClassifs).length > 0
    || Object.keys(lineArticleMap).length > 0
    || Object.keys(aiSuggestions).length > 0
    || hasAnyLineProjects(lineProjects)
    || cdcRows.length > 0
    || invProjects.length > 0
    || Object.keys(lineConfidences).length > 0
    || Object.keys(lineReviewFlags).length > 0
    || Object.keys(lineDetails).length > 0
    || Object.keys(lineFiscalFlags).length > 0
    || Object.keys(lineActions).length > 0
    || invoiceNotes.length > 0
    || pipelineDebug != null
  ), [classification, lineClassifs, lineArticleMap, aiSuggestions, lineProjects, cdcRows, invProjects, lineConfidences, lineReviewFlags, lineDetails, lineFiscalFlags, lineActions, invoiceNotes, pipelineDebug]);

  useEffect(() => {
    setArticles(referenceData.articles);
  }, [referenceData.articles]);

  useEffect(() => {
    setAllCategories(referenceData.categories);
  }, [referenceData.categories]);

  useEffect(() => {
    setAllProjects(referenceData.projects);
  }, [referenceData.projects]);

  useEffect(() => {
    setAllAccounts(referenceData.accounts);
  }, [referenceData.accounts]);

  // Apply a ready invoice bundle in a single state swap to avoid flicker and stale interleaving.
  useEffect(() => {
    if (!activeDetailBundle) return;

    const map: Record<string, LineArticleInfo> = {};
    const dbSuggestions: Record<string, MatchResult> = {};

    for (const assignment of activeDetailBundle.lineAssignments) {
      const art = assignment.article as any;
      const fullArt = articles.find(article => article.id === assignment.article_id);
      const phase = assignment.phase_id ? fullArt?.phases?.find(p => p.id === assignment.phase_id) : null;
      if (assignment.verified) {
        map[assignment.invoice_line_id] = {
          article_id: assignment.article_id,
          code: art?.code || '',
          name: art?.name || '',
          assigned_by: assignment.assigned_by,
          verified: assignment.verified,
          location: assignment.location,
          phase_id: assignment.phase_id || null,
          phase_code: phase?.code || null,
          phase_name: phase?.name || null,
        };
        continue;
      }
      if (fullArt) {
        dbSuggestions[assignment.invoice_line_id] = {
          article: fullArt,
          confidence: Number(assignment.confidence) || 50,
          matchedKeywords: [],
          totalKeywords: fullArt.keywords.length,
          source: 'deterministic',
          phase_id: assignment.phase_id || null,
        };
      }
    }

    const runtimeSuggestions: Record<string, MatchResult> = {};
    if (activeDetailBundle.detail?.invoice_lines && articles.length > 0) {
      for (const line of activeDetailBundle.detail.invoice_lines) {
        if (map[line.id] || dbSuggestions[line.id]) continue;
        const match = matchWithLearnedRules(line.description, articles, referenceData.learnedRules);
        if (match && match.confidence >= 70) {
          runtimeSuggestions[line.id] = match;
        }
      }
    }

    startTransition(() => {
      setClassification(activeDetailBundle.classification);
      setInvProjects(activeDetailBundle.invoiceProjects);
      setOriginalInvoiceProjects(activeDetailBundle.invoiceProjects);
      setOriginalClassificationSnapshot({
        category_id: activeDetailBundle.classification?.category_id || null,
        account_id: activeDetailBundle.classification?.account_id || null,
      });
      setInvoiceNotes(buildAggregatedNotes(activeDetailBundle.invoiceNotes, activeDetailBundle.lineFiscalFlags));
      setLineClassifs(activeDetailBundle.lineClassifs);
      setOriginalLineClassifs(activeDetailBundle.lineClassifs);
      setLineProjects(activeDetailBundle.lineProjects);
      setOriginalLineProjects(activeDetailBundle.lineProjects);
      setLineFiscalFlags(activeDetailBundle.lineFiscalFlags);
      setLineConfidences(activeDetailBundle.lineConfidences);
      setLineReviewFlags(activeDetailBundle.lineReviewFlags);
      setLineActions(activeDetailBundle.lineActions);
      setLineDetails(activeDetailBundle.lineDetails || {});
      setPendingFiscalChoices([]);
      setCdcRows(activeDetailBundle.invoiceProjects.map(ip => ({
        project_id: ip.project_id,
        percentage: Number(ip.percentage),
        amount: ip.amount ?? null,
      })));
      setSelCategoryId(activeDetailBundle.classification?.category_id || null);
      setSelAccountId(activeDetailBundle.classification?.account_id || null);
      setClassifDirty(false);
      setClearPending(false);
      setLineArticleMap(map);
      setOriginalLineArticleMap(map);
      setAiSuggestions({ ...runtimeSuggestions, ...dbSuggestions });
      setDismissedArticleLineIds(new Set());
      setAiClassifResult(null);
      setAiClassifStatus('idle');
      setPipelineDebug(null);
      setLineSuggestions({});
      setDismissedSuggestions(new Set());
      setBulkArticleId(null);
      setBulkPhaseId(null);
      setShowZeroLines(false);
    });
  }, [activeDetailBundle, invoice.id, articles, referenceData.learnedRules]);

  // Unified save: classification + CdC rows (batch)
  const handleSaveClassification = useCallback(async () => {
    const companyId = company?.id;
    if (!companyId || !invoice?.id) return;
    setClassifSaving(true);
    try {
      // Save category + account
      await saveInvoiceClassification(companyId, invoice.id, selCategoryId, selAccountId);
      // Save CdC rows (batch delete+insert)
      const total = Math.abs(invoice.total_amount || 0);
      const rowsToSave = cdcRows.map(r => ({
        project_id: r.project_id,
        percentage: r.percentage,
        amount: cdcMode === 'amount' ? r.amount : (total > 0 ? Math.round(total * r.percentage / 100 * 100) / 100 : null),
      }));
      await saveInvoiceProjects(companyId, invoice.id, rowsToSave);
      // Reload from DB to sync
      const freshProjs = await loadInvoiceProjects(invoice.id);
      setInvProjects(freshProjs);
      setCdcRows(freshProjs.map(ip => ({
        project_id: ip.project_id,
        percentage: Number(ip.percentage),
        amount: ip.amount ?? null,
      })));
      setClassifDirty(false);

      // Save article assignments on lines
      if (detail?.invoice_lines) {
        for (const line of detail.invoice_lines) {
          const curr = lineArticleMap[line.id];
          const orig = originalLineArticleMap[line.id];
          const changed = (!curr && orig) || (curr && !orig) ||
            (curr && orig && (curr.article_id !== orig.article_id || curr.phase_id !== orig.phase_id));
          if (!changed) continue;
          if (!curr && orig) {
            await removeLineAssignment(line.id).catch(() => {});
          } else if (curr) {
            await assignArticleToLine(
              companyId, line.id, invoice.id, curr.article_id,
              { quantity: line.quantity, unit_price: line.unit_price, total_price: line.total_price, vat_rate: line.vat_rate },
              'manual', undefined, curr.location, curr.phase_id,
            );
          }
        }
        setOriginalLineArticleMap({ ...lineArticleMap });
      }

      // Save line-level CdC allocations that changed
      if (detail?.invoice_lines) {
        for (const line of detail.invoice_lines) {
          const curr = (lineProjects[line.id] || []).map(p => `${p.project_id}:${p.percentage}`).sort().join(',');
          const orig = (originalLineProjects[line.id] || []).map(p => `${p.project_id}:${p.percentage}`).sort().join(',');
          if (curr !== orig) {
            await saveLineProjects(companyId, invoice.id, line.id,
              (lineProjects[line.id] || []).map(p => ({ project_id: p.project_id, percentage: p.percentage, amount: p.amount })));
          }
        }
        setOriginalLineProjects({ ...lineProjects });
      }

      // Create classification rules from confirmed line-level data (fire-and-forget)
      // v2: includes fiscal_flags for learning loop
      // v3: includes contract_ref from DatiContratto.IdDocumento
      const cp = (invoice.counterparty || {}) as any;
      let contractRefForRules: string | null = null;
      try {
        if (detail?.raw_xml) {
          const px = parseXmlDetail(detail.raw_xml);
          const b0 = px?.bodies?.[0];
          if (b0?.contratti?.length) contractRefForRules = b0.contratti[0]?.id || null;
        }
      } catch { /* ignore */ }

      if (detail?.invoice_lines) {
        for (const line of detail.invoice_lines) {
          const lc = lineClassifs[line.id];
          if (lc?.category_id || lc?.account_id) {
            const lineCdc = lineProjects[line.id]?.length
              ? lineProjects[line.id].map(p => ({ project_id: p.project_id, percentage: p.percentage }))
              : (cdcRows.length > 0 ? cdcRows.map(c => ({ project_id: c.project_id, percentage: c.percentage })) : null);
            const lineFF = lineFiscalFlags[line.id] || null;
            createRuleFromConfirmation(
              companyId, cp?.piva || null, cp?.denom || null,
              line.description, invoice.direction as 'in' | 'out',
              { category_id: lc.category_id, account_id: lc.account_id,
                article_id: lineArticleMap[line.id]?.article_id || null,
                phase_id: lineArticleMap[line.id]?.phase_id || null,
                cost_center_allocations: lineCdc,
                fiscal_flags: lineFF },
              invoice.id,
              contractRefForRules,
            ).catch(err => console.warn('[rules] error:', err));
          }
        }
      }

      // Refresh sidebar badges
      onRefreshBadges(invoice.id);
    } catch (e: any) { console.error('Save classification error:', e); }
    setClassifSaving(false);
  }, [company?.id, invoice?.id, selCategoryId, selAccountId, cdcRows, cdcMode, detail?.invoice_lines,
    lineClassifs, lineArticleMap, originalLineArticleMap, lineProjects, originalLineProjects,
    invoice?.counterparty, invoice?.direction, onRefreshBadges, lineFiscalFlags, detail?.raw_xml]);

  // Local CdC row management (no DB calls)
  const handleAddCdc = useCallback(() => {
    if (!addCdcId) return;
    const total = Math.abs(invoice?.total_amount || 0);
    const currentPct = cdcRows.reduce((s, r) => s + r.percentage, 0);
    const remainPct = Math.max(0, 100 - currentPct);
    setCdcRows(prev => [...prev, {
      project_id: addCdcId,
      percentage: remainPct,
      amount: total > 0 ? Math.round(total * remainPct / 100 * 100) / 100 : null,
    }]);
    setAddCdcId('');
    setClassifDirty(true);
  }, [addCdcId, cdcRows, invoice?.total_amount]);

  const handleRemoveCdc = useCallback((projectId: string) => {
    setCdcRows(prev => {
      const remaining = prev.filter(r => r.project_id !== projectId);
      // Auto-fill 100% if exactly 1 center remains
      if (remaining.length === 1) {
        const total = Math.abs(invoice?.total_amount || 0);
        return [{ ...remaining[0], percentage: 100, amount: total > 0 ? total : null }];
      }
      return remaining;
    });
    setClassifDirty(true);
  }, [invoice?.total_amount]);

  const handleCdcPctChange = useCallback((projectId: string, pct: number) => {
    const total = Math.abs(invoice?.total_amount || 0);
    setCdcRows(prev => prev.map(r =>
      r.project_id === projectId
        ? { ...r, percentage: pct, amount: total > 0 ? Math.round(total * pct / 100 * 100) / 100 : null }
        : r
    ));
    setClassifDirty(true);
  }, [invoice?.total_amount]);

  const handleCdcAmtChange = useCallback((projectId: string, amt: number) => {
    const total = Math.abs(invoice?.total_amount || 0);
    setCdcRows(prev => prev.map(r =>
      r.project_id === projectId
        ? { ...r, amount: amt, percentage: total > 0 ? Math.round(amt / total * 100 * 100) / 100 : 0 }
        : r
    ));
    setClassifDirty(true);
  }, [invoice?.total_amount]);

  // CdC validation: allocation must sum to 100% (percentage mode) or exact invoice total (amount mode)
  const cdcValidation = useMemo(() => {
    if (cdcRows.length === 0) return { valid: true, message: '' };
    const invTotal = Math.abs(invoice?.total_amount || 0);
    const totalPct = Math.round(cdcRows.reduce((s, r) => s + r.percentage, 0) * 100) / 100;
    const totalAmt = Math.round(cdcRows.reduce((s, r) => s + (r.amount ?? (invTotal > 0 ? invTotal * r.percentage / 100 : 0)), 0) * 100) / 100;
    if (cdcMode === 'percentage') {
      const ok = Math.abs(totalPct - 100) < 0.01;
      return { valid: ok, message: ok ? '' : `La somma delle percentuali deve essere 100% (attuale: ${fmtNum(totalPct)}%)` };
    } else {
      const ok = Math.abs(totalAmt - invTotal) < 0.01;
      return { valid: ok, message: ok ? '' : `La somma degli importi deve essere ${fmtEur(invTotal)} (attuale: ${fmtEur(totalAmt)})` };
    }
  }, [cdcRows, cdcMode, invoice?.total_amount]);

  // Line-level classification: update category or account for a single line
  // Line-level classification: LOCAL ONLY — DB write deferred to explicit "Salva"
  const handleLineClassifChange = useCallback((lineId: string, field: 'category_id' | 'account_id', value: string | null) => {
    setLineClassifs(prev => ({
      ...prev,
      [lineId]: {
        ...prev[lineId],
        invoice_line_id: lineId,
        category_id: field === 'category_id' ? value : (prev[lineId]?.category_id ?? null),
        account_id: field === 'account_id' ? value : (prev[lineId]?.account_id ?? null),
      },
    }));
  }, []);

  // AI classification — check rules first, then classify
  const handleRequestAiClassification = useCallback(async () => {
    if (!invoice?.id || !company?.id) return;
    const cp = (invoice.counterparty || {}) as any;
    const lines = detail?.invoice_lines || [];

    // Pre-check: look for matching rules (instant, 0ms)
    const ruleSuggestions = await findMatchingRules(
      company.id, cp?.piva || null, cp?.denom || null,
      lines.map(l => ({ id: l.id, description: l.description })),
      invoice.direction as 'in' | 'out',
    );

    // If rules cover ALL lines, ask user before applying
    const coveredLineIds = new Set(ruleSuggestions.map(s => s.line_id));
    const allCovered = lines.length > 0 && lines.every(l => coveredLineIds.has(l.id));
    if (allCovered && ruleSuggestions.length > 0) {
      setPendingRuleSuggestions(ruleSuggestions);
      setShowRulesDialog(true);
      return; // Wait for user choice
    }

    // If rules don't cover all lines (or no rules), run normally
    runAiClassification(false);
  }, [invoice?.id, company?.id, invoice?.counterparty, invoice?.direction, detail?.invoice_lines]);

  // Core classification logic — called after rules dialog or directly
  const runAiClassification = useCallback((skipRules: boolean) => {
    if (!invoice?.id || !company?.id) return;

    const runInvoiceId = invoice.id;
    const cp = (invoice.counterparty || {}) as any;
    const lines = detail?.invoice_lines || [];

    setAiClassifStatus('loading');
    setAiClassifResult(null);
    setPipelineDebug(null);
    setShowRulesDialog(false);
    setAiBannerStatus('idle');
    setProposedConsultantAction(null);

    startSingleInvoiceJob(async (signal, updateProgress, appendLog) => {
      appendLog?.(`Avvio classificazione su ${lines.length} righe${skipRules ? ' (forzando AI)' : ''}`);

      // Extract contract refs from XML (DatiContratto.IdDocumento)
      let invoiceContractRefs: string[] = [];
      try {
        if (detail?.raw_xml) {
          const parsedXml = parseXmlDetail(detail.raw_xml);
          const body0 = parsedXml?.bodies?.[0];
          if (body0?.contratti?.length) {
            invoiceContractRefs = body0.contratti.map((c: any) => c.id).filter(Boolean);
          }
        }
      } catch { /* ignore XML parse errors */ }

      const pipelineResult = await runClassificationPipeline(
        company.id,
        runInvoiceId,
        lines.map(l => ({
          line_id: l.id,
          description: l.description,
          quantity: l.quantity,
          unit_price: l.unit_price,
          total_price: l.total_price,
          vat_rate: l.vat_rate,
        })),
        invoice.direction as 'in' | 'out',
        cp?.piva || null,
        cp?.denom || null,
        signal,
        {
          onStage: (stage, current, total, message) => {
            updateProgress(current, total, { stage, message });
          },
          onProgress: (current, total, meta) => {
            updateProgress(current, total, meta);
          },
          onLog: (text) => appendLog?.(text),
        },
        invoiceContractRefs,
      );

      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!mountedRef.current || activeInvoiceIdRef.current !== runInvoiceId) return;

      const mergedLines = pipelineResult.lines.map(lr => ({
        invoice_line_id: lr.line_id,
        line_id: lr.line_id,
        article_id: lr.article_id,
        phase_id: lr.phase_id,
        category_id: lr.category_id,
        account_id: lr.account_id,
        project_allocations: lr.cost_center_allocations || [],
        match_type: lr.source as any,
        confidence: lr.confidence,
        reasoning: lr.reasoning,
        reasoning_summary_final: lr.reasoning_summary_final,
        decision_status: lr.decision_status,
        final_decision_source: lr.final_decision_source,
        final_confidence: lr.confidence,
        decision_basis: lr.decision_basis,
        supporting_factors: lr.supporting_factors,
        supporting_evidence: lr.supporting_evidence,
        fiscal_flags: lr.fiscal_flags,
        suggest_new_account: lr.suggest_new_account,
        suggest_new_category: lr.suggest_new_category,
        classification_reasoning: lr.classification_reasoning || null,
        classification_thinking: lr.classification_thinking || null,
        fiscal_reasoning: lr.fiscal_reasoning || null,
        fiscal_thinking: lr.fiscal_thinking || null,
        fiscal_confidence: lr.fiscal_confidence ?? null,
      }));

      const classified = pipelineResult.lines.filter(l =>
        l.decision_status === 'finalized' && l.confidence >= 60 && (l.category_id || l.account_id),
      );
      const best = classified.length > 0
        ? classified.reduce((a, b) => b.confidence > a.confidence ? b : a)
        : null;
      const invoiceReasoning = pipelineResult.cfo?.invoice_summary_final
        || pipelineResult.commercialista?.invoice_summary
        || `Pipeline vNext: ${pipelineResult.stats.deterministic} evidenze deterministiche, ${pipelineResult.stats.ai_classified} proposte AI`;
      const invoiceConfidence = classified.length > 0
        ? Math.round(classified.reduce((sum, line) => sum + line.confidence, 0) / classified.length)
        : 0;

      const result = {
        invoice_id: runInvoiceId,
        lines: mergedLines,
        invoice_level: best ? {
          category_id: best.category_id,
          account_id: best.account_id,
          project_allocations: best.cost_center_allocations || [],
          confidence: invoiceConfidence,
          reasoning: invoiceReasoning,
        } : {
          category_id: null, account_id: null, project_allocations: [],
          confidence: 0, reasoning: invoiceReasoning || 'Nessuna classificazione riuscita',
        },
        stats: pipelineResult.stats,
        commercialista: pipelineResult.commercialista,
        cfo: pipelineResult.cfo,
      };

      setAiClassifResult(result);
      setAiClassifStatus('done');
      if (pipelineResult.debug) setPipelineDebug(pipelineResult.debug);
      onPatchInvoice(runInvoiceId, { classification_status: 'ai_suggested' } as Partial<DBInvoice>);
      onInvalidateBundle(runInvoiceId);

      const flags: Record<string, any> = {};
      for (const lr of mergedLines) {
        if (lr.invoice_line_id) {
          // Merge backward-compat fiscal_flags with full V1 typed fields
          // so that createRuleFromConfirmation saves the complete fiscal data
          const pipelineLine = pipelineResult.lines.find(pl => pl.line_id === lr.invoice_line_id);
          const fv1 = (pipelineLine as any)?.fiscal_v1;
          flags[lr.invoice_line_id] = {
            ...(lr.fiscal_flags || {}),
            ...(fv1 ? {
              iva_detraibilita_pct: fv1.iva_detraibilita_pct,
              deducibilita_ires_pct: fv1.deducibilita_ires_pct,
              irap_mode: fv1.irap_mode,
              irap_pct: fv1.irap_pct ?? null,
              ritenuta_applicabile: fv1.ritenuta_applicabile,
              ritenuta_tipo: fv1.ritenuta_tipo ?? null,
              ritenuta_aliquota_pct: fv1.ritenuta_aliquota_pct ?? null,
              ritenuta_base_pct: fv1.ritenuta_base_pct ?? null,
              cassa_previdenziale_pct: fv1.cassa_previdenziale_pct ?? null,
              reverse_charge: fv1.reverse_charge,
              split_payment: fv1.split_payment,
              bene_strumentale: fv1.bene_strumentale,
              asset_candidate: fv1.asset_candidate,
              asset_category_guess: fv1.asset_category_guess ?? null,
              ammortamento_aliquota_proposta: fv1.ammortamento_aliquota_proposta ?? null,
              debt_related: fv1.debt_related,
              debt_type: fv1.debt_type ?? null,
              competenza_dal: fv1.competenza_dal ?? null,
              competenza_al: fv1.competenza_al ?? null,
              costo_personale: fv1.costo_personale,
              warning_flags: fv1.warning_flags,
              fiscal_reasoning_short: fv1.fiscal_reasoning_short ?? null,
            } : {}),
          };
        }
      }
      setLineFiscalFlags(flags);

      const confs: Record<string, number> = {};
      const reviews: Record<string, boolean> = {};
      for (const lr of (result.lines || [])) {
        const lid = lr.line_id || lr.invoice_line_id;
        if (lid) {
          if (lr.confidence != null) confs[lid] = lr.confidence;
          reviews[lid] = lr.decision_status !== 'finalized'
            || lr.confidence < 65
            || !!(lr.fiscal_flags?.note && /verificar|controllare|dubbio/i.test(String(lr.fiscal_flags?.note || '')))
            || lr.suggest_new_account != null;
        }
      }
      setLineConfidences(confs);
      setLineReviewFlags(reviews);

      const aiInvoiceNotes = [...(pipelineResult.alerts || [])] as FiscalAlert[];
      for (const lr of (result.lines || [])) {
        const lid = lr.line_id || lr.invoice_line_id;
        if (lid && lr.suggest_new_account) {
          const s = lr.suggest_new_account;
          const existing = aiInvoiceNotes.find(n => n.affected_lines?.includes(lid));
          if (!existing) {
            aiInvoiceNotes.push({
              type: 'general' as const,
              severity: 'info' as const,
              title: `Suggerimento: nuovo conto ${s.code}`,
              description: `L'AI suggerisce di creare il conto "${s.code} - ${s.name}" (sezione: ${s.section}, sotto: ${s.parent_code}). Motivo: ${s.reason}`,
              current_choice: 'Usando conto esistente come fallback',
              options: [
                { label: `Crea conto "${s.code}"`, fiscal_override: {}, is_default: false },
                { label: 'Mantieni conto attuale', fiscal_override: {}, is_default: true },
              ],
              affected_lines: [lid],
            });
          }
        }
      }
      setInvoiceNotes(buildAggregatedNotes(aiInvoiceNotes, flags));

      const suggestions: Record<string, { suggest_new_account?: AccountSuggestion | null; suggest_new_category?: CategorySuggestion | null }> = {};
      for (const lr of (result.lines || [])) {
        const lid = lr.line_id || lr.invoice_line_id;
        if (lid && (lr.suggest_new_account || lr.suggest_new_category)) {
          suggestions[lid] = {
            suggest_new_account: (lr.suggest_new_account as unknown as AccountSuggestion) || null,
            suggest_new_category: (lr.suggest_new_category as unknown as CategorySuggestion) || null,
          };
        }
      }
      setLineSuggestions(suggestions);
      setDismissedSuggestions(new Set());

      // Immediately populate lineDetails from pipeline result (instant display before DB reload)
      const freshDetails: Record<string, LineDetailData> = {};
      for (const lr of (result.lines || [])) {
        const lid = lr.line_id || (lr as any).invoice_line_id;
        if (lid) {
          freshDetails[lid] = {
            classification_reasoning: (lr as any).classification_reasoning || lr.reasoning || null,
            classification_thinking: (lr as any).classification_thinking || null,
            fiscal_reasoning: (lr as any).fiscal_reasoning || null,
            fiscal_thinking: (lr as any).fiscal_thinking || null,
            fiscal_confidence: (lr as any).fiscal_confidence ?? null,
            reasoning_summary_final: (lr as any).reasoning_summary_final || null,
            decision_status: (lr as any).decision_status || null,
            final_confidence: (lr as any).final_confidence ?? lr.confidence ?? null,
            final_decision_source: (lr as any).final_decision_source || null,
            line_note: null,
            line_note_source: null,
            line_note_updated_at: null,
          };
        }
      }
      setLineDetails(prev => ({ ...prev, ...freshDetails }));

      try {
        const [classif, lineClfResult, lineProj, freshInvProjs, freshAssignments] = await Promise.all([
          loadInvoiceClassification(runInvoiceId),
          loadLineClassifications(runInvoiceId),
          loadLineProjects(runInvoiceId),
          loadInvoiceProjects(runInvoiceId),
          supabase.from('invoice_line_articles')
            .select('invoice_line_id, article_id, phase_id, assigned_by, verified, location, confidence, article:articles!inner(id, code, name, unit, keywords)')
            .eq('invoice_id', runInvoiceId).then(r => r.data || []),
        ]);

        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (!mountedRef.current || activeInvoiceIdRef.current !== runInvoiceId) return;

        const lineClf = lineClfResult.classifs;
        setLineFiscalFlags(prev => ({ ...lineClfResult.fiscalFlags, ...prev }));
        setLineConfidences(prev => ({ ...lineClfResult.confidences, ...prev }));
        setLineReviewFlags(prev => ({ ...lineClfResult.reviewFlags, ...prev }));
        setLineActions(prev => ({ ...prev, ...lineClfResult.lineActions }));
        setLineDetails(prev => ({ ...prev, ...lineClfResult.lineDetails }));

        const freshMap: Record<string, LineArticleInfo> = {};
        const freshDbSugg: Record<string, MatchResult> = {};
        for (const a of freshAssignments) {
          const art = (a as any).article;
          const fullArtWithPhases = articles.find(ar => ar.id === a.article_id);
          const phase = a.phase_id ? fullArtWithPhases?.phases?.find(p => p.id === a.phase_id) : null;
          if (a.verified) {
            freshMap[a.invoice_line_id] = {
              article_id: a.article_id, code: art?.code || '', name: art?.name || '',
              assigned_by: a.assigned_by, verified: a.verified, location: a.location,
              phase_id: a.phase_id || null, phase_code: phase?.code || null, phase_name: phase?.name || null,
            };
          } else {
            const fullArt = articles.find(ar => ar.id === a.article_id);
            if (fullArt) {
              freshDbSugg[a.invoice_line_id] = {
                article: fullArt, confidence: Number(a.confidence) || 50,
                matchedKeywords: [], totalKeywords: fullArt.keywords.length, source: 'deterministic',
              };
            }
          }
        }
        setAiSuggestions(freshDbSugg);
        if (classif) {
          setClassification(classif);
          setSelCategoryId(classif.category_id || selCategoryId);
          setSelAccountId(classif.account_id || selAccountId);
        }

        const mergedLineClf = { ...lineClf };
        for (const ml of mergedLines) {
          const lineId = ml.invoice_line_id;
          if (lineId && (ml.category_id || ml.account_id)) {
            mergedLineClf[lineId] = {
              invoice_line_id: lineId,
              category_id: ml.category_id || mergedLineClf[lineId]?.category_id || null,
              account_id: ml.account_id || mergedLineClf[lineId]?.account_id || null,
            };
          }
        }
        setLineClassifs(mergedLineClf);

        const mergedLineProj = { ...lineProj };
        for (const ml of mergedLines) {
          const lineId = ml.invoice_line_id;
          if (lineId && ml.project_allocations?.length > 0 && !mergedLineProj[lineId]?.length) {
            mergedLineProj[lineId] = ml.project_allocations.map((pa: { project_id: string; percentage: number }) => ({
              id: `ai_${lineId}_${pa.project_id}`,
              invoice_line_id: lineId,
              project_id: pa.project_id,
              percentage: pa.percentage,
              amount: null,
            }));
          }
        }
        setLineProjects(mergedLineProj);

        const mergedArticleMap = { ...freshMap };
        for (const ml of mergedLines) {
          const lineId = ml.invoice_line_id;
          if (lineId && ml.article_id && !mergedArticleMap[lineId]) {
            const art = articles.find(a => a.id === ml.article_id);
            if (art) {
              const fullArt = art as ArticleWithPhases;
              const phase = ml.phase_id ? fullArt.phases?.find(p => p.id === ml.phase_id) : null;
              mergedArticleMap[lineId] = {
                article_id: ml.article_id, code: art.code || '', name: art.name || '',
                assigned_by: ml.match_type === 'rule' ? 'rule' : 'ai_classification',
                verified: false, location: null,
                phase_id: ml.phase_id || null, phase_code: phase?.code || null, phase_name: phase?.name || null,
              };
            }
          }
        }
        setLineArticleMap(mergedArticleMap);

        if (freshInvProjs.length > 0) {
          setInvProjects(freshInvProjs);
          setCdcRows(freshInvProjs.map(ip => ({
            project_id: ip.project_id,
            percentage: Number(ip.percentage),
            amount: ip.amount ?? null,
          })));
        } else if (result.invoice_level?.project_allocations?.length > 0) {
          const total = Math.abs(invoice.total_amount || 0);
          setCdcRows(result.invoice_level.project_allocations.map((pa: { project_id: string; percentage: number }) => ({
            project_id: pa.project_id,
            percentage: pa.percentage,
            amount: total > 0 ? Math.round(total * pa.percentage / 100 * 100) / 100 : null,
          })));
        }
      } catch (syncErr) {
        if (syncErr instanceof DOMException && syncErr.name === 'AbortError') throw syncErr;
        console.warn('[AI classification] post-sync warning:', syncErr);
      }
    }, 6);
  }, [invoice?.id, invoice?.counterparty, invoice?.direction, invoice?.total_amount, company?.id, detail?.invoice_lines, selCategoryId, selAccountId, onPatchInvoice, onInvalidateBundle, startSingleInvoiceJob, articles]);

  // Confirm AI suggestion — set verified=true on invoice_classifications + line-level records
  // NOTE: handleConfirmAiClassification, handleRejectAiClassification, handleConfirmExistingClassification
  // have been removed. All saves go through the universal handleConfirmChanges (Save button).

  // Handle "Crea e usa" for AI-suggested new account/category
  const handleCreateSuggestion = useCallback(async (lineId: string) => {
    if (!company?.id) return;
    setCreatingSuggestion(lineId);
    try {
      const sugg = lineSuggestions[lineId];
      let newAccountId: string | null = null;
      let newCategoryId: string | null = null;

      if (sugg?.suggest_new_account) {
        const acct = await createAccountFromSuggestion(company.id, sugg.suggest_new_account);
        newAccountId = acct.id;
        toast.success(`Conto ${acct.code} "${acct.name}" creato`);
      }
      if (sugg?.suggest_new_category) {
        const { category, wasExisting } = await createCategoryFromSuggestion(company.id, sugg.suggest_new_category);
        newCategoryId = category.id;
        if (wasExisting) toast.info(`Categoria "${category.name}" già esistente — usata`);
        else toast.success(`Categoria "${category.name}" creata`);
      }

      // Update line classification with new IDs
      if (newAccountId || newCategoryId) {
        const current = lineClassifs[lineId] || {} as any;
        await saveLineCategoryAndAccount(
          lineId,
          newCategoryId || current.category_id || null,
          newAccountId || current.account_id || null,
        );
        // Reload line classifications + refresh accounts/categories lists
        const companyId = company.id;
        const [lineClfResult, freshCats, freshAccs] = await Promise.all([
          loadLineClassifications(invoice!.id),
          loadCategories(companyId, true),
          loadChartOfAccounts(companyId),
        ]);
        setLineClassifs(lineClfResult.classifs);
        setLineFiscalFlags(prev => ({ ...prev, ...lineClfResult.fiscalFlags }));
        setLineDetails(prev => ({ ...prev, ...lineClfResult.lineDetails }));
        setAllCategories(freshCats);
        setAllAccounts(freshAccs.filter(a => !a.is_header && a.active));
        // Refresh sidebar badges
        onRefreshBadges(invoice!.id);
        onInvalidateBundle(invoice!.id);
      }

      // Dismiss this suggestion
      setDismissedSuggestions(prev => new Set([...prev, lineId]));
    } catch (err: any) {
      toast.error(`Errore: ${err.message}`);
    }
    setCreatingSuggestion(null);
  }, [company?.id, invoice?.id, lineSuggestions, lineClassifs, onRefreshBadges, onInvalidateBundle]);

  // Handle "Ignora" for AI-suggested new account/category
  const handleDismissSuggestion = useCallback((lineId: string) => {
    setDismissedSuggestions(prev => new Set([...prev, lineId]));
  }, []);

  // Batch-save all deferred changes (universal "Salva" for any invoice status)
  const handleConfirmChanges = useCallback(async () => {
    const companyId = company?.id;
    if (!companyId || !invoice?.id) return;
    const cp = (invoice.counterparty || {}) as any;
    setConfirmChangesSaving(true);
    try {
      const learningWarnings: string[] = [];
      const pushLearningWarning = (label: string, error: unknown) => {
        console.warn(`[learning] ${label}:`, error);
        const message = error instanceof Error ? error.message : String(error ?? 'errore sconosciuto');
        learningWarnings.push(`${label}: ${message}`);
      };
      const hasAnyData = !!(
        selCategoryId ||
        selAccountId ||
        Object.values(lineClassifs).some(lc => lc?.category_id || lc?.account_id) ||
        Object.keys(lineArticleMap).length > 0
      );

      // 1. Save invoice-level classification (category, account, CdC) if dirty
      if (classifDirty && hasAnyData) {
        await saveInvoiceClassification(companyId, invoice.id, selCategoryId, selAccountId);
        const total = Math.abs(invoice.total_amount || 0);
        const rowsToSave = cdcRows.map(r => ({
          project_id: r.project_id,
          percentage: r.percentage,
          amount: cdcMode === 'amount' ? r.amount : (total > 0 ? Math.round(total * r.percentage / 100 * 100) / 100 : null),
        }));
        await saveInvoiceProjects(companyId, invoice.id, rowsToSave);
      }

      // 2. Save changed line classifications
      const lcKeys = new Set([...Object.keys(lineClassifs), ...Object.keys(originalLineClassifs)]);
      for (const k of lcKeys) {
        const curr = lineClassifs[k];
        const orig = originalLineClassifs[k];
        if (curr?.category_id !== orig?.category_id || curr?.account_id !== orig?.account_id) {
          await saveLineCategoryAndAccount(k, curr?.category_id ?? null, curr?.account_id ?? null);
        }
      }

      // 3. Save changed article assignments
      const artKeys = new Set([...Object.keys(lineArticleMap), ...Object.keys(originalLineArticleMap)]);
      for (const k of artKeys) {
        const curr = lineArticleMap[k];
        const orig = originalLineArticleMap[k];
        const changed = (!curr && orig) || (curr && !orig) ||
          (curr && orig && (curr.article_id !== orig.article_id || curr.phase_id !== orig.phase_id));
        if (!changed) continue;
        if (!curr && orig) {
          // Removed
          await removeLineAssignment(k);
        } else if (curr) {
          // Added or changed
          const dbLine = detail?.invoice_lines?.find(dl => dl.id === k);
          await assignArticleToLine(
            companyId, k, invoice.id, curr.article_id,
            { quantity: dbLine?.quantity, unit_price: dbLine?.unit_price, total_price: dbLine?.total_price, vat_rate: dbLine?.vat_rate },
            'manual', undefined, curr.location, curr.phase_id,
          );
        }
      }

      // 3a. Delete dismissed AI article suggestions from DB
      for (const lineId of dismissedArticleLineIds) {
        await removeLineAssignment(lineId).catch(() => {});
      }

      // 3b. Save changed line-level CdC allocations
      const projKeys = new Set([...Object.keys(lineProjects), ...Object.keys(originalLineProjects)]);
      for (const k of projKeys) {
        const curr = (lineProjects[k] || []).map(p => `${p.project_id}:${p.percentage}`).sort().join(',');
        const orig = (originalLineProjects[k] || []).map(p => `${p.project_id}:${p.percentage}`).sort().join(',');
        if (curr !== orig) {
          await saveLineProjects(companyId, invoice.id, k,
            (lineProjects[k] || []).map(p => ({ project_id: p.project_id, percentage: p.percentage, amount: p.amount })));
        }
      }

      // 4. Determine and apply classification status
      if (!hasAnyData) {
        // User cleared everything → delete classification and set status 'none'
        await clearInvoiceNotes(invoice.id);
        await saveInvoiceProjects(companyId, invoice.id, []);
        await clearAllLineProjects(invoice.id);
        await clearAllLineClassifications(invoice.id);
        await clearInvoiceDecisionTrail(invoice.id);
        await deleteInvoiceClassification(invoice.id);
        await supabase.from('invoices').update({ classification_status: 'none' } as any).eq('id', invoice.id);
        onPatchInvoice(invoice.id, { classification_status: 'none', has_fiscal_alerts: false } as Partial<DBInvoice>);
        onSetClassifMeta(invoice.id, EMPTY_INVOICE_CLASSIF_META);
        setClassification(null);
        setSelCategoryId(null);
        setSelAccountId(null);
        setInvProjects([]);
        setCdcRows([]);
        setInvoiceNotes([]);
        setShowZeroLines(false);

        try {
          await deactivateRulesForInvoice(invoice.id);
        } catch (error) {
          pushLearningWarning('revoca regole classificazione', error);
        }
        try {
          await deleteFiscalDecisionsForInvoice(invoice.id);
        } catch (error) {
          pushLearningWarning('revoca decisioni fiscali', error);
        }
        try {
          await deleteInvoiceMemoryFacts(invoice.id);
        } catch (error) {
          pushLearningWarning('revoca memoria fattura', error);
        }
        setPendingFiscalChoices([]);
      } else {
        const newStatus = isConfirmed ? 'confirmed' : 'manual';
        await supabase.from('invoice_classifications').update({ verified: true, assigned_by: 'manual', updated_at: new Date().toISOString() }).eq('invoice_id', invoice.id);
        // Ensure invoice_classifications row exists (upsert for fresh classifications)
        if (!isConfirmed && !classification) {
          await supabase.from('invoice_classifications').upsert({
            invoice_id: invoice.id,
            company_id: company.id,
            category_id: selCategoryId,
            account_id: selAccountId,
            assigned_by: 'manual',
            verified: true,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'invoice_id' });
        }
        await supabase.from('invoices').update({ classification_status: newStatus } as any).eq('id', invoice.id);
        onPatchInvoice(invoice.id, { classification_status: newStatus } as Partial<DBInvoice>);
        try {
          await deactivateRulesForInvoice(invoice.id);
        } catch (error) {
          pushLearningWarning('riallineamento regole classificazione', error);
        }
        try {
          await deleteInvoiceMemoryFacts(invoice.id, ['invoice_classification']);
        } catch (error) {
          pushLearningWarning('riallineamento memoria classificazione', error);
        }
        if (pendingFiscalChoices.length > 0) {
          try {
            await deleteFiscalDecisionsForInvoice(invoice.id);
          } catch (error) {
            pushLearningWarning('reset decisioni fiscali precedenti', error);
          }
          try {
            await deleteInvoiceMemoryFacts(invoice.id, ['invoice_fiscal_choice']);
          } catch (error) {
            pushLearningWarning('riallineamento memoria fiscale', error);
          }
        }

        if (detail?.invoice_lines) {
          for (const line of detail.invoice_lines) {
            const lc = lineClassifs[line.id];
            if (!(lc?.category_id || lc?.account_id)) continue;

            const lineCdc = lineProjects[line.id]?.length
              ? lineProjects[line.id].map(p => ({ project_id: p.project_id, percentage: p.percentage }))
              : (cdcRows.length > 0 ? cdcRows.map(c => ({ project_id: c.project_id, percentage: c.percentage })) : null);
            const lineFF = lineFiscalFlags[line.id] || null;

            try {
              await createRuleFromConfirmation(
                companyId, cp?.piva || null, cp?.denom || null,
                line.description, invoice.direction as 'in' | 'out',
                {
                  category_id: lc.category_id,
                  account_id: lc.account_id,
                  article_id: lineArticleMap[line.id]?.article_id || null,
                  phase_id: lineArticleMap[line.id]?.phase_id || null,
                  cost_center_allocations: lineCdc,
                  fiscal_flags: lineFF,
                },
                invoice.id,
                primaryContractRef,
              );
            } catch (error) {
              pushLearningWarning(`salvataggio regola riga "${line.description.slice(0, 40)}"`, error);
            }

            const memAcc = lc.account_id ? allAccounts.find(a => a.id === lc.account_id) : null;
            const memCat = lc.category_id ? allCategories.find(c => c.id === lc.category_id) : null;
            const memArt = lineArticleMap[line.id];
            try {
              await createMemoryFromClassification(
                companyId, cp?.id || null, cp?.denom || null,
                line.description, memCat?.name || null,
                memAcc?.code || null, memAcc?.name || null,
                invoice.direction as 'in' | 'out',
                memArt?.code || null, memArt?.name || null,
                {
                  sourceInvoiceId: invoice.id,
                  origin: 'invoice_classification',
                  contractRef: primaryContractRef,
                  contractRefs: primaryContractRef ? [primaryContractRef] : [],
                },
              );
            } catch (error) {
              pushLearningWarning(`salvataggio memoria riga "${line.description.slice(0, 40)}"`, error);
            }
          }
        }

        let fiscalChoicesSynced = true;
        for (const choice of pendingFiscalChoices) {
          try {
            await createMemoryFromFiscalChoice(
              companyId,
              cp?.id || null,
              cp?.denom || null,
              choice.alert_title,
              choice.chosen_option_label,
              choice.alert_type,
              choice.fiscal_override,
              invoice.id,
            );
          } catch (error) {
            fiscalChoicesSynced = false;
            pushLearningWarning(`salvataggio memoria fiscale "${choice.alert_title}"`, error);
          }

          if (!cp?.piva) {
            fiscalChoicesSynced = false;
            learningWarnings.push(`decisione fiscale "${choice.alert_title}" non salvata: P.IVA controparte mancante`);
            continue;
          }

          try {
            await saveFiscalDecision(
              companyId,
              invoice.id,
              choice.line_description,
              cp.piva,
              invoice.direction as 'in' | 'out',
              {
                type: choice.alert_type,
                chosen_option_label: choice.chosen_option_label,
                fiscal_override: choice.fiscal_override,
              },
              choice.contract_ref,
              choice.account_id,
            );
          } catch (error) {
            fiscalChoicesSynced = false;
            pushLearningWarning(`salvataggio decisione fiscale "${choice.alert_title}"`, error);
          }
        }

        if (fiscalChoicesSynced) {
          setPendingFiscalChoices([]);
        }
      }

      // 5. Update original snapshots so dirty state resets
      setOriginalLineClassifs({ ...lineClassifs });
      setOriginalLineArticleMap({ ...lineArticleMap });
      setOriginalLineProjects({ ...lineProjects });
      setOriginalInvoiceProjects([...invProjects]);
      setOriginalClassificationSnapshot({
        category_id: selCategoryId || null,
        account_id: selAccountId || null,
      });
      setDismissedArticleLineIds(new Set());
      setClassifDirty(false);
      setClearPending(false);

      // 6. Persist updated fiscal flags for lines that were modified by fiscal review
      for (const [lineId, ff] of Object.entries(lineFiscalFlags)) {
        if (ff) {
          await saveLineFiscalFlags(lineId, ff);
        }
      }

      // 7. Clear invoice_notes if all alerts resolved, update has_fiscal_alerts
      if (invoiceNotes.length === 0) {
        await clearInvoiceNotes(invoice.id);
      }

      // 8. Refresh badges in sidebar
      onRefreshBadges(invoice.id);
      onInvalidateBundle(invoice.id);
      if (learningWarnings.length > 0) {
        toast.warning(`Modifiche salvate con ${learningWarnings.length} warning di apprendimento`);
      } else {
        toast.success('Modifiche salvate');
      }
    } catch (e: any) {
      console.error('Confirm changes error:', e);
      toast.error('Errore nel salvataggio delle modifiche');
    }
    setConfirmChangesSaving(false);
  }, [company?.id, invoice?.id, invoice?.total_amount, invoice?.counterparty, invoice?.direction,
    isConfirmed, classification, classifDirty, selCategoryId, selAccountId, cdcRows, cdcMode,
    lineClassifs, originalLineClassifs, lineArticleMap, originalLineArticleMap,
    lineProjects, originalLineProjects, dismissedArticleLineIds,
    detail?.invoice_lines, onPatchInvoice, onRefreshBadges, onSetClassifMeta, onInvalidateBundle, allAccounts, allCategories,
    lineFiscalFlags, invoiceNotes, pendingFiscalChoices, primaryContractRef]);

  // Copy classification from a line
  const handleCopyLineClassif = useCallback((lineId: string) => {
    const lc = lineClassifs[lineId];
    const lp = lineProjects[lineId] || [];
    setCopiedClassif({
      category_id: lc?.category_id ?? null,
      account_id: lc?.account_id ?? null,
      projects: lp.map(p => ({ project_id: p.project_id, percentage: p.percentage })),
    });
    toast.success('Classificazione copiata');
  }, [lineClassifs, lineProjects]);

  // Paste classification to a line
  const handlePasteLineClassif = useCallback(async (lineId: string) => {
    if (!copiedClassif || !company?.id || !invoice?.id) return;
    // Apply category + account locally
    setLineClassifs(prev => ({
      ...prev,
      [lineId]: {
        ...prev[lineId],
        invoice_line_id: lineId,
        category_id: copiedClassif.category_id,
        account_id: copiedClassif.account_id,
      },
    }));
    // Apply CdC locally
    if (copiedClassif.projects.length > 0) {
      setLineProjects(prev => ({
        ...prev,
        [lineId]: copiedClassif.projects.map(p => ({
          id: crypto.randomUUID(),
          invoice_line_id: lineId,
          project_id: p.project_id,
          percentage: p.percentage,
          amount: null,
        })),
      }));
    }
    // All changes are local — user clicks "Salva" to persist
    toast.success('Classificazione incollata — clicca Salva per confermare');
  }, [copiedClassif, company?.id, invoice?.id]);

  // Clear all classification
  const handleClearAllClassification = useCallback(async () => {
    if (!invoice?.id) return;
    // Clear all local state
    setClassification(null);
    setSelCategoryId(null);
    setSelAccountId(null);
    setCdcRows([]);
    setInvProjects([]);
    setLineClassifs({});
    setLineProjects({});
    setLineArticleMap({});
    setLineFiscalFlags({});
    setLineConfidences({});
    setLineReviewFlags({});
    setLineActions({});
    setLineDetails({});
    setInvoiceNotes([]);
    setPendingFiscalChoices([]);
    setAiSuggestions({});
    setLineSuggestions({});
    setDismissedSuggestions(new Set());
    setDismissedArticleLineIds(new Set());
    setAiClassifResult(null);
    setProposedConsultantAction(null);
    setAiClassifStatus('idle');
    setAiBannerStatus('idle');
    setPipelineDebug(null);
    setShowZeroLines(false);
    setClearPending(true);
    // Mark invoice-level as dirty so Save button detects the change
    setClassifDirty(true);
    // NOTE: Do NOT reset originals — we want isPostConfirmDirty = true → Save appears
    setShowClearDialog(false);
    // Also clear fiscal_flags from DB immediately (they live on invoice_lines)
    try {
      await clearAllLineClassifications(invoice.id);
    } catch (e) {
      console.warn('[clear] Error clearing fiscal_flags from DB:', e);
    }
    try {
      await clearAllLineProjects(invoice.id);
    } catch (e) {
      console.warn('[clear] Error clearing line projects from DB:', e);
    }
    try {
      await clearInvoiceDecisionTrail(invoice.id);
    } catch (e) {
      console.warn('[clear] Error clearing invoice decision trail:', e);
    }
    try {
      await clearInvoiceNotes(invoice.id);
      onPatchInvoice(invoice.id, { has_fiscal_alerts: false } as Partial<DBInvoice>);
    } catch (e) {
      console.warn('[clear] Error clearing invoice fiscal notes from DB:', e);
    }
    if (company?.id) {
      try {
        await saveInvoiceProjects(company.id, invoice.id, []);
      } catch (e) {
        console.warn('[clear] Error clearing invoice-level projects from DB:', e);
      }
    }
    // Revoke learning artifacts immediately as well, so legacy rules/decisions
    // do not survive while the invoice is visually cleared in the UI.
    try {
      await deactivateRulesForInvoice(invoice.id);
    } catch (e) {
      console.warn('[clear] Error deactivating classification rules:', e);
    }
    try {
      await deleteFiscalDecisionsForInvoice(invoice.id);
    } catch (e) {
      console.warn('[clear] Error deleting fiscal decisions:', e);
    }
    try {
      await deleteInvoiceMemoryFacts(invoice.id);
    } catch (e) {
      console.warn('[clear] Error deactivating invoice memory facts:', e);
    }
    onInvalidateBundle(invoice.id);
  }, [company?.id, invoice?.id, onInvalidateBundle, onPatchInvoice]);

  // ─── Fiscal Review: handle user choice on an alert ─────
  const applyFiscalChoice = useCallback((alertIdx: number, option: FiscalAlertOption) => {
    const alert = invoiceNotes[alertIdx];
    if (!alert) return;

    // Apply fiscal_override to all affected lines
    setLineFiscalFlags(prev => {
      const updated = { ...prev };
      for (const lineId of alert.affected_lines) {
        updated[lineId] = { ...(updated[lineId] || {}), ...option.fiscal_override };
      }
      return updated;
    });
    setClassifDirty(true);
    const firstLineId = alert.affected_lines[0];
    const firstLine = detail?.invoice_lines?.find(l => l.id === firstLineId);
    setPendingFiscalChoices(prev => [
      ...prev.filter(choice => !(choice.first_line_id === firstLineId && choice.alert_type === alert.type)),
      {
        first_line_id: firstLineId,
        alert_type: alert.type,
        alert_title: alert.title,
        chosen_option_label: option.label,
        fiscal_override: option.fiscal_override,
        affected_lines: [...alert.affected_lines],
        line_description: firstLine?.description || alert.title,
        contract_ref: primaryContractRef,
        account_id: lineClassifs[firstLineId]?.account_id || null,
      },
    ]);

    // Remove resolved alert
    setInvoiceNotes(prev => prev.filter((_, i) => i !== alertIdx));
  }, [invoiceNotes, detail?.invoice_lines, lineClassifs, primaryContractRef]);

  const handleFiscalChoice = useCallback((alertIdx: number, option: FiscalAlertOption | null) => {
    if (!option) {
      // Skip — just remove the alert
      setInvoiceNotes(prev => prev.filter((_, i) => i !== alertIdx));
      return;
    }

    // Non-conservative choice → require note
    if (option.isConservative === false) {
      requiredNoteTextRef.current = option.suggestedNote || '';
      setRequiredNoteDialog({ alertIdx, option, suggestedNote: option.suggestedNote || '' });
      return;
    }

    // Conservative or no metadata → apply directly
    applyFiscalChoice(alertIdx, option);
  }, [applyFiscalChoice]);

  const handleAssignArticle = useCallback(async (lineId: string, articleId: string, lineDesc: string, lineData: { quantity: number; unit_price: number; total_price: number; vat_rate: number }, suggestedPhaseId?: string | null) => {
    const companyId = company?.id;
    if (!companyId || !invoice?.id) return;
    const location = extractLocation(lineDesc);
    const art = articles.find(a => a.id === articleId) as ArticleWithPhases | undefined;
    const hasPhases = (art?.phases?.length ?? 0) > 0;

    // If a suggested phase was provided (from AI), resolve its details
    let phase = suggestedPhaseId ? art?.phases?.find(p => p.id === suggestedPhaseId) : null;

    // Auto-select first phase if article has phases but none was suggested
    if (!phase && hasPhases && art?.phases) {
      const sorted = [...art.phases].sort((a, b) => a.sort_order - b.sort_order);
      phase = sorted.find(p => p.is_counting_point) || sorted[0] || null;
    }

    // LOCAL ONLY — DB write deferred to explicit "Salva"
    setLineArticleMap(prev => ({
      ...prev,
      [lineId]: {
        article_id: articleId, code: art?.code || '', name: art?.name || '',
        assigned_by: 'manual', verified: true, location,
        phase_id: phase?.id || null, phase_code: phase?.code || null, phase_name: phase?.name || null,
      },
    }));
    setAiSuggestions(prev => { const n = { ...prev }; delete n[lineId]; return n; });
  }, [company?.id, invoice?.id, articles]);

  // Assign a phase to a line that already has an article
  const handleAssignPhase = useCallback(async (lineId: string, phaseId: string | null) => {
    const companyId = company?.id;
    if (!companyId || !invoice?.id) return;
    const info = lineArticleMap[lineId];
    if (!info) return;
    const art = articles.find(a => a.id === info.article_id) as ArticleWithPhases | undefined;
    const phase = phaseId ? art?.phases?.find(p => p.id === phaseId) : null;

    // LOCAL ONLY — DB write deferred to explicit "Salva"
    setLineArticleMap(prev => ({
      ...prev,
      [lineId]: {
        ...prev[lineId],
        phase_id: phaseId,
        phase_code: phase?.code || null,
        phase_name: phase?.name || null,
      },
    }));
  }, [company?.id, invoice?.id, articles, lineArticleMap]);

  // LOCAL ONLY — DB write deferred to explicit "Salva"
  const handleRemoveArticle = useCallback((lineId: string) => {
    setLineArticleMap(prev => { const n = { ...prev }; delete n[lineId]; return n; });
  }, []);

  // Dismiss AI article suggestion for a line (removes from aiSuggestions without assigning)
  // Also tracks the dismissal so dirty state triggers Salva → persists removal to DB
  const handleDismissArticleSuggestion = useCallback((lineId: string) => {
    setAiSuggestions(prev => { const n = { ...prev }; delete n[lineId]; return n; });
    setDismissedArticleLineIds(prev => new Set([...prev, lineId]));
  }, []);

  // Bulk assign article + phase to all invoice lines
  const handleBulkAssignArticle = useCallback(async () => {
    const companyId = company?.id;
    if (!companyId || !invoice?.id || !bulkArticleId) return;
    const lines = detail?.invoice_lines;
    if (!lines?.length) return;
    const art = articles.find(a => a.id === bulkArticleId);
    const hasPhases = (art as ArticleWithPhases)?.phases?.length > 0;
    if (hasPhases && !bulkPhaseId) return; // validation: phase required
    const phase = bulkPhaseId ? (art as ArticleWithPhases)?.phases?.find(p => p.id === bulkPhaseId) : null;
    const location = null; // bulk doesn't use location

    // Optimistic / local update
    const prevMap = { ...lineArticleMap };
    const newMap: Record<string, LineArticleInfo> = {};
    for (const l of lines) {
      newMap[l.id] = {
        article_id: bulkArticleId, code: art?.code || '', name: art?.name || '',
        assigned_by: 'manual', verified: true, location,
        phase_id: bulkPhaseId, phase_code: phase?.code || null, phase_name: phase?.name || null,
      };
    }
    setLineArticleMap(newMap);
    setAiSuggestions({});
    toast.info(`Articolo ${art?.code} assegnato a ${lines.length} righe — clicca Salva per confermare`);
  }, [company?.id, invoice?.id, bulkArticleId, bulkPhaseId, articles, detail?.invoice_lines, lineArticleMap]);

  // Unified bulk apply — pushes ANY selected fields to all lines
  const handleBulkApplyAll = useCallback(() => {
    const lines = detail?.invoice_lines;
    if (!lines?.length) return;
    const applied: string[] = [];

    // 1) Push category + account to all line-level overrides
    if (selCategoryId || selAccountId) {
      const newLineClf = { ...lineClassifs };
      for (const l of lines) {
        const prev = newLineClf[l.id] || { invoice_line_id: l.id, category_id: null, account_id: null };
        newLineClf[l.id] = {
          ...prev,
          invoice_line_id: l.id,
          category_id: selCategoryId || prev.category_id,
          account_id: selAccountId || prev.account_id,
        };
      }
      setLineClassifs(newLineClf);
      if (selCategoryId) applied.push('Categoria');
      if (selAccountId) applied.push('Conto');
    }

    // 2) Push CdC to all line-level projects
    if (cdcRows.length > 0) {
      const newLineProj = { ...lineProjects };
      for (const l of lines) {
        newLineProj[l.id] = cdcRows.map(r => ({
          id: '', // placeholder — will be assigned by DB on save
          invoice_line_id: l.id,
          project_id: r.project_id,
          percentage: r.percentage,
          amount: r.amount ?? null,
        }));
      }
      setLineProjects(newLineProj);
      applied.push('CdC');
    }

    // 3) Push article + phase to all lines (auto-select default phase if needed)
    if (bulkArticleId) {
      const art = articles.find(a => a.id === bulkArticleId);
      const hasPhases = (art as ArticleWithPhases)?.phases?.length > 0;
      let effectivePhaseId = bulkPhaseId;
      let effectivePhase: { code: string; name: string } | null = null;

      if (hasPhases && !effectivePhaseId) {
        // Auto-select default phase: first counting point or first phase
        const sorted = [...((art as ArticleWithPhases)?.phases || [])].sort((a, b) => a.sort_order - b.sort_order);
        const defaultPhase = sorted.find(p => p.is_counting_point) || sorted[0];
        if (defaultPhase) {
          effectivePhaseId = defaultPhase.id;
          effectivePhase = { code: defaultPhase.code, name: defaultPhase.name };
          setBulkPhaseId(defaultPhase.id); // Update the dropdown too
        }
      } else if (effectivePhaseId) {
        const ph = (art as ArticleWithPhases)?.phases?.find(p => p.id === effectivePhaseId);
        effectivePhase = ph ? { code: ph.code, name: ph.name } : null;
      }

      const newMap: Record<string, LineArticleInfo> = {};
      for (const l of lines) {
        newMap[l.id] = {
          article_id: bulkArticleId, code: art?.code || '', name: art?.name || '',
          assigned_by: 'manual', verified: true, location: null,
          phase_id: effectivePhaseId, phase_code: effectivePhase?.code || null, phase_name: effectivePhase?.name || null,
        };
      }
      setLineArticleMap(newMap);
      setAiSuggestions({});
      applied.push(`Art. ${art?.code}${effectivePhase ? ` → ${effectivePhase.code}` : ''}`);
    }

    if (applied.length > 0) {
      setClassifDirty(true);
      toast.info(`Applicato ${applied.join(', ')} a ${lines.length} righe — clicca Salva per confermare`);
    }
  }, [detail?.invoice_lines, selCategoryId, selAccountId, cdcRows, bulkArticleId, bulkPhaseId, articles, lineClassifs, lineProjects]);

  // Header dropdown apply — applies selected value ONLY to empty cells
  const handleHeaderApplyCategory = useCallback((categoryId: string) => {
    const lines = detail?.invoice_lines;
    if (!lines?.length || !categoryId) return;
    const newLineClf = { ...lineClassifs };
    let count = 0;
    for (const l of lines) {
      const prev = newLineClf[l.id];
      if (!prev?.category_id) {
        newLineClf[l.id] = { ...prev, invoice_line_id: l.id, category_id: categoryId, account_id: prev?.account_id ?? null };
        count++;
      }
    }
    if (count > 0) {
      setLineClassifs(newLineClf);
      setClassifDirty(true);
      toast.info(`Categoria applicata a ${count} righe vuote`);
    }
  }, [detail?.invoice_lines, lineClassifs]);

  const handleHeaderApplyAccount = useCallback((accountId: string) => {
    const lines = detail?.invoice_lines;
    if (!lines?.length || !accountId) return;
    const newLineClf = { ...lineClassifs };
    let count = 0;
    for (const l of lines) {
      const prev = newLineClf[l.id];
      if (!prev?.account_id) {
        newLineClf[l.id] = { ...prev, invoice_line_id: l.id, category_id: prev?.category_id ?? null, account_id: accountId };
        count++;
      }
    }
    if (count > 0) {
      setLineClassifs(newLineClf);
      setClassifDirty(true);
      toast.info(`Conto applicato a ${count} righe vuote`);
    }
  }, [detail?.invoice_lines, lineClassifs]);

  const handleHeaderApplyCdc = useCallback((projectId: string) => {
    const lines = detail?.invoice_lines;
    if (!lines?.length || !projectId) return;
    const newLineProj = { ...lineProjects };
    let count = 0;
    for (const l of lines) {
      if (!newLineProj[l.id]?.length) {
        newLineProj[l.id] = [{ id: '', invoice_line_id: l.id, project_id: projectId, percentage: 100, amount: null }];
        count++;
      }
    }
    if (count > 0) {
      setLineProjects(newLineProj);
      setClassifDirty(true);
      toast.info(`CdC applicato a ${count} righe vuote`);
    }
  }, [detail?.invoice_lines, lineProjects]);

  // State for header dropdown popovers — portal-based to escape overflow container
  const [headerDropdown, setHeaderDropdown] = useState<'category' | 'account' | 'cdc' | null>(null);
  const [headerDropdownRect, setHeaderDropdownRect] = useState<DOMRect | null>(null);
  const [headerDropdownSearch, setHeaderDropdownSearch] = useState('');
  const headerDropdownRef = useRef<HTMLDivElement>(null);
  const headerDropdownSearchRef = useRef<HTMLInputElement>(null);

  const openHeaderDropdown = useCallback((type: 'category' | 'account' | 'cdc', e: React.MouseEvent) => {
    if (headerDropdown === type) { setHeaderDropdown(null); return; }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setHeaderDropdownRect(rect);
    setHeaderDropdownSearch('');
    setHeaderDropdown(type);
    // Auto-focus search input after render
    setTimeout(() => headerDropdownSearchRef.current?.focus(), 50);
  }, [headerDropdown]);

  // Close header dropdown on outside click or scroll (portal-aware)
  useEffect(() => {
    if (!headerDropdown) return;
    const clickHandler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-header-dropdown-trigger]')) return;
      if (headerDropdownRef.current?.contains(target)) return;
      setHeaderDropdown(null);
    };
    const scrollHandler = (e: Event) => {
      if (headerDropdownRef.current?.contains(e.target as Node)) return;
      setHeaderDropdown(null);
    };
    document.addEventListener('mousedown', clickHandler);
    window.addEventListener('scroll', scrollHandler, true);
    return () => {
      document.removeEventListener('mousedown', clickHandler);
      window.removeEventListener('scroll', scrollHandler, true);
    };
  }, [headerDropdown]);

  // Reset notes when invoice changes
  useEffect(() => { setNotesText(invoice.notes || ''); }, [invoice.id, invoice.notes]);

  // Notes auto-save with debounce (1s)
  useEffect(() => {
    if (notesText === (invoice.notes || '')) return;
    clearTimeout(notesDebounceRef.current);
    notesDebounceRef.current = setTimeout(async () => {
      setNotesSaving(true);
      try {
        await supabase.from('invoices').update({ notes: notesText }).eq('id', invoice.id);
      } catch {}
      setNotesSaving(false);
    }, 1000);
    return () => clearTimeout(notesDebounceRef.current);
  }, [notesText, invoice.id, invoice.notes]);

  const handleSaveNotes = useCallback(async () => {
    clearTimeout(notesDebounceRef.current);
    setNotesSaving(true);
    try {
      await supabase.from('invoices').update({ notes: notesText }).eq('id', invoice.id);
    } catch {}
    setNotesSaving(false);
  }, [notesText, invoice.id]);

  useEffect(() => {
    if (detail?.raw_xml) {
      try { setParsed(parseXmlDetail(detail.raw_xml)); } catch { setParsed(null); }
    } else { setParsed(null); }
  }, [detail?.raw_xml]);

  const handleSave = async (u: InvoiceUpdate) => { await onEdit(u); setEditing(false); onReload(); };

  const downloadXml = () => {
    if (!detail?.raw_xml) return;
    const blob = new Blob([detail.raw_xml], { type: 'text/xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = invoice.source_filename.replace(/\.p7m$/i, '').replace(/\.xml$/i, '') + '.xml';
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  };

  const downloadAllegato = (att: any) => {
    if (!att.b64) return;
    const mimeMap: Record<string, string> = { PDF: 'application/pdf', XML: 'text/xml', TXT: 'text/plain', CSV: 'text/csv', PNG: 'image/png', JPG: 'image/jpeg', JPEG: 'image/jpeg' };
    const mime = mimeMap[(att.formato || '').toUpperCase()] || 'application/octet-stream';
    const binary = atob(att.b64);
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
    const blob = new Blob([arr], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = att.nome || 'allegato';
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  };


  // Compute whether classification tab has an unconfirmed indicator
  const hasPersistedClassificationData = !!(
    classification
    || Object.keys(lineClassifs).length > 0
    || Object.keys(lineArticleMap).length > 0
    || hasAnyLineProjects(lineProjects)
    || cdcRows.length > 0
    || invProjects.length > 0
  );
  const hasReviewableAiSuggestion = invoice.classification_status === 'ai_suggested'
    && hasPersistedClassificationData
    && aiClassifStatus !== 'loading'
    && !singleInvoiceJobRunning;
  const classifNeedsAttention = hasReviewableAiSuggestion;
  const showDetailSkeleton = referenceDataLoading
    || detailPhase === 'loading'
    || detailPhase === 'refreshing'
    || (detailBundle != null && detailBundle.invoiceId !== invoice.id)
    || (detailPhase !== 'ready' && !detailBundle);

  const nc = invoice.doc_type === 'TD04' || invoice.doc_type === 'TD05';
  const d = parsed;
  const b = d?.bodies?.[0];
  const cp = (invoice.counterparty || {}) as any;
  const cpStatus = String(counterpartyHeaderInfo.status || invoice.counterparty_status_snapshot || '').toLowerCase();
  const showCounterpartyAlert = cpStatus === 'pending' || cpStatus === 'rejected' || !invoice.counterparty_id;
  const hasRefs = b?.contratti?.length > 0 || b?.ordini?.length > 0 || b?.convenzioni?.length > 0;

  // Filter zero-amount lines (metadata /D lines like IBAN, bank refs)
  const visibleXmlLines = (() => {
    const all = b?.linee || [];
    if (showZeroLines) return all;
    return all.filter((l: any) => {
      const total = safeFloat(l.prezzoTotale);
      const unit = safeFloat(l.prezzoUnitario);
      return total !== 0 || unit !== 0;
    });
  })();
  const visibleDbLines = (() => {
    const all = detail?.invoice_lines || [];
    if (showZeroLines) return all;
    return all.filter(l => (l.total_price ?? 0) !== 0 || (l.unit_price ?? 0) !== 0);
  })();
  const totalLineCount = b?.linee?.length || detail?.invoice_lines?.length || 0;
  const visibleLineCount = visibleXmlLines.length || visibleDbLines.length;
  const hiddenLineCount = totalLineCount - visibleLineCount;

  // Classified count — only count visible lines
  const visibleLineIds = new Set(
    (visibleXmlLines.length ? visibleXmlLines : visibleDbLines).map((l: any) => {
      if (l.id) return l.id;
      const dbLine = detail?.invoice_lines?.find(dl => dl.line_number === parseInt(l.numero || '0'));
      return dbLine?.id;
    }).filter(Boolean)
  );
  const classifiedLineCount = Object.keys(lineClassifs)
    .filter(lid => visibleLineIds.has(lid) && (lineClassifs[lid]?.category_id || lineClassifs[lid]?.account_id))
    .length;

  // Informational line counts for the counter
  const skippedLineCount = Object.values(lineActions).filter(a => a.line_action === 'skip').length;
  const groupedLineCount = Object.values(lineActions).filter(a => a.line_action === 'group').length;
  const informationalTotal = skippedLineCount + groupedLineCount;

  return (
    <div className="flex flex-col h-full bg-slate-50/50 overflow-y-auto" id="invoice-detail-print">
        {/* CARD 1 — Counterparty header */}
        <div className="mx-4 mt-3 bg-white border border-slate-200 rounded-xl flex-shrink-0 shadow-sm">
          {/* Row 1: Counterparty name + amount hero */}
          <div className="flex items-start justify-between px-5 pt-4 pb-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <button
                  onClick={onNavigateCounterparty}
                  className="text-lg font-bold text-slate-900 hover:text-slate-600 cursor-pointer bg-transparent border-none p-0 text-left truncate max-w-[420px]"
                  title="Vai alla controparte"
                >
                  {cp?.denom || invoice.source_filename || 'Sconosciuto'}
                </button>
              </div>
              {cp?.piva && <span className="text-[10px] text-slate-400 block mt-0.5">#IVA {cp.piva}</span>}
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <span className={`px-2.5 py-1 rounded-md text-[11px] font-semibold ${STATUS_COLORS[invoice.payment_status] || 'bg-slate-100 text-slate-600'}`}>
                {getStatusLabel(invoice.payment_status, invoice.direction)}
              </span>
              <span className="text-xl font-bold text-slate-900">{fmtEur(invoice.total_amount)}</span>
            </div>
          </div>
          {/* Row 2: Metadata 3-col + action buttons */}
          <div className="flex items-end justify-between px-5 pb-3">
            <div className="grid grid-cols-3 gap-x-8 text-xs flex-1">
              <div>
                <span className="text-[10px] text-slate-400 uppercase tracking-wide">Tipo doc</span>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                    invoice.direction === 'in' ? 'bg-slate-100 text-slate-600' : 'bg-slate-100 text-slate-600'
                  }`}>
                    {invoice.direction === 'in' ? 'Passivo' : 'Attivo'}
                  </span>
                  <span className="text-[10px] text-slate-500">{tpLabel(invoice.doc_type) || invoice.doc_type}</span>
                </div>
              </div>
              <div>
                <span className="text-[10px] text-slate-400 uppercase tracking-wide">Controparte</span>
                {(counterpartyHeaderInfo.atecoDescription || counterpartyHeaderInfo.provinceSigla) && (
                  <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                    {counterpartyHeaderInfo.atecoDescription && (
                      <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-slate-50 text-slate-500">
                        {counterpartyHeaderInfo.atecoDescription}
                      </span>
                    )}
                    {counterpartyHeaderInfo.provinceSigla && (
                      <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-slate-50 text-slate-500">
                        {counterpartyHeaderInfo.provinceSigla}
                      </span>
                    )}
                  </div>
                )}
                <p className="font-medium text-slate-700 mt-0.5">{invoice.number || '\u2014'} {'\u2014'} {fmtDate(invoice.date)}</p>
              </div>
              <div>
                <span className="text-[10px] text-slate-400 uppercase tracking-wide">Scadenza</span>
                <p className={`font-semibold mt-0.5 ${invoice.payment_status === 'overdue' ? 'text-red-600' : 'text-slate-700'}`}>
                  {invoice.payment_due_date ? fmtDate(invoice.payment_due_date) : '\u2014'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {detail?.raw_xml && (
                <button onClick={() => setShowXml(!showXml)} className={`w-6 h-6 flex items-center justify-center rounded text-[9px] transition-colors ${showXml ? 'bg-slate-700 text-white' : 'bg-slate-100 hover:bg-slate-200 text-slate-400'}`} title="Vedi XML">&lt;/&gt;</button>
              )}
              {detail?.raw_xml && (
                <button onClick={downloadXml} className="w-6 h-6 flex items-center justify-center rounded bg-slate-100 hover:bg-slate-200 text-slate-400 text-[9px]" title="Scarica XML">{'\u2B07'}</button>
              )}
              <button onClick={() => window.print()} className="w-6 h-6 flex items-center justify-center rounded bg-slate-100 hover:bg-slate-200 text-slate-400 text-[9px]" title="Stampa">{'\uD83D\uDDA8'}</button>
              <button onClick={() => setEditing(!editing)} className={`w-6 h-6 flex items-center justify-center rounded text-[9px] transition-colors ${editing ? 'bg-slate-700 text-white' : 'bg-slate-100 hover:bg-slate-200 text-slate-400'}`} title="Modifica">{'\u270F'}</button>
              <button onClick={onOpenScadenzario} className="w-6 h-6 flex items-center justify-center rounded bg-slate-100 hover:bg-slate-200 text-slate-400 text-[9px]" title="Scadenzario">{'\uD83D\uDCC5'}</button>
              <button onClick={onDelete} className="w-6 h-6 flex items-center justify-center rounded bg-slate-100 hover:bg-red-100 text-slate-400 hover:text-red-500 text-[9px]" title="Elimina">{'\uD83D\uDDD1'}</button>
            </div>
          </div>
        </div>

      {/* CARD 2 — AI Assistant */}
      <div className="mx-4 mt-3 flex-shrink-0">
        <AIAssistantBanner
          status={
            aiBannerStatus === 'consulting' ? 'consulting' :
            aiBannerStatus === 'proposed' ? 'proposed' :
            aiBannerStatus === 'applied' ? 'applied' :
            (aiClassifStatus === 'loading' || singleInvoiceJobRunning) ? 'processing' :
            invoiceNotes.length > 0 ? 'alerts' :
            (aiClassifResult || hasPersistedClassificationData || invoice.classification_status === 'confirmed') ? 'done' :
            'idle'
          }
          onStartClassification={handleRequestAiClassification}
          lineCount={detail?.invoice_lines?.length}
          progressSteps={singleInvoiceJob ? [
            { label: 'Regole e storico', status: singleInvoiceJob.stage === 'Ricerca regole e storico' ? 'running' : 'done' as const },
            { label: 'Commercialista', status: ['Ricerca regole e storico'].includes(singleInvoiceJob.stage || '') ? 'pending' : singleInvoiceJob.stage === 'Commercialista' ? 'running' : 'done' as const },
            { label: 'Centri di costo', status: ['Ricerca regole e storico', 'Commercialista'].includes(singleInvoiceJob.stage || '') ? 'pending' : singleInvoiceJob.stage === 'Attribuzione CdC' ? 'running' : 'done' as const },
            ...(singleInvoiceJob.stage === 'Consulente' ? [{ label: 'Consulente AI', status: 'running' as const }] : []),
            { label: 'Salvataggio', status: singleInvoiceJob.stage === 'Salvataggio risultati' ? 'running' : ['Ricerca regole e storico', 'Commercialista', 'Attribuzione CdC', 'Consulente'].includes(singleInvoiceJob.stage || '') ? 'pending' : 'done' as const },
          ] : undefined}
          elapsedSeconds={singleInvoiceJobRunning ? Math.round((singleInvoiceJobProgress.pct || 0) / 10) : undefined}
          alerts={invoiceNotes}
          onAlertAction={(action) => {
            const alertIdx = resolveInvoiceAlertIndex(action.alertId);
            const alert = alertIdx >= 0 ? invoiceNotes[alertIdx] : null;
            if (action.option && 'type' in action.option && action.option.type === 'consult') {
              if (alert) handleStartChat(alert);
            } else {
              if (alertIdx >= 0) handleFiscalChoice(alertIdx, action.option as FiscalAlertOption);
            }
          }}
          chatMessages={chatMessages}
          onSendMessage={handleSendChatMessage}
          quickReplyOptions={activeConsultAlert?.options}
          onQuickReply={handleConsultantQuickReply}
          onApplyAction={handleApplyConsultantAction}
          onKeepCurrentDecision={handleKeepCurrentDecision}
          onAskFollowUp={handleAskConsultantFollowUp}
          chatLoading={chatLoading}
          chatAlertTitle={chatAlertContext}
          proposedAction={proposedConsultantAction}
          summary={aiClassifResult ? (aiClassifResult.invoice_level?.reasoning || `Classificate ${aiClassifResult.lines?.length || 0} righe`) : invoice.classification_status === 'confirmed' ? 'Classificazione confermata' : undefined}
          onRestart={handleRequestAiClassification}
        />

        {/* Pipeline Debug Panel — visible only after fresh classification */}
        {pipelineDebug && pipelineDebug.length > 0 && (
          <details className="mt-3 border border-slate-200 rounded-xl overflow-hidden shadow-sm">
            <summary className="px-5 py-3 bg-slate-50/80 backdrop-blur-sm cursor-pointer text-sm font-semibold text-slate-700 hover:bg-slate-100 flex items-center gap-2 transition-colors">
              <span className="text-base grayscale opacity-70">🔍</span>
              Dettagli Pipeline AI ({pipelineDebug.length} step visibili)
            </summary>
            <div className="p-5 space-y-4 bg-white">
              {pipelineDebug.map((step, i) => (
                <PipelineStepDetailPanel key={i} step={step} />
              ))}
            </div>
          </details>
        )}
      </div>

      {/* CARD 3 — Tabs + content */}
      <div className="mx-4 mt-3 mb-12 flex flex-col bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex-shrink-0">
        {/* Tab bar */}
        <div className="flex border-b border-slate-200 flex-shrink-0 px-5 gap-1">
          {DETAIL_TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2.5 text-xs font-medium border-b-2 transition-all ${
                activeTab === tab.key
                  ? 'text-slate-900 border-slate-900'
                  : 'text-slate-400 border-transparent hover:text-slate-600 hover:border-slate-300'
              }`}
            >
              {tab.label}
              {tab.key === 'dettaglio' && classifNeedsAttention && (
                <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-orange-400 inline-block" />
              )}
            </button>
          ))}
        </div>

        {/* TAB CONTENT */}
        <div className="flex-1">
        {/* XML viewer (always visible when toggled) */}
        {showXml && detail?.raw_xml && (
          <div className="mx-4 mt-3 bg-gray-900 rounded-lg overflow-hidden border print:hidden">
            <div className="flex justify-between items-center px-3 py-2 bg-gray-800">
              <span className="text-sky-300 text-xs font-semibold">XML Sorgente {'\u2014'} {Math.round(detail.raw_xml.length / 1024)} KB</span>
              <button onClick={() => navigator.clipboard?.writeText(detail.raw_xml)} className="bg-gray-700 text-gray-300 border-none rounded px-2 py-1 text-[10px] cursor-pointer hover:bg-gray-600">Copia</button>
            </div>
            <pre className="m-0 p-3 text-gray-300 text-[10px] font-mono overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap break-all leading-relaxed">{detail.raw_xml}</pre>
          </div>
        )}

        {editing && <div className="px-4 pt-3"><EditForm invoice={invoice} onSave={handleSave} onCancel={() => setEditing(false)} /></div>}

        {/* Counterparty alert */}
        {showCounterpartyAlert && (
          <div className={`mx-4 mt-3 rounded-lg border px-3 py-2.5 ${
            cpStatus === 'rejected' ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'
          }`}>
            <p className={`text-sm font-semibold ${cpStatus === 'rejected' ? 'text-red-800' : 'text-amber-800'}`}>
              {cpStatus === 'rejected' ? 'Controparte respinta' : 'Controparte da verificare'}
            </p>
            <div className="flex gap-2 mt-2">
              <button onClick={() => onOpenCounterparty('verify')} className="px-2.5 py-1 text-xs font-semibold rounded border border-sky-300 bg-white text-sky-700 hover:bg-sky-50">Verifica</button>
              <button onClick={() => onOpenCounterparty('edit')} className="px-2.5 py-1 text-xs font-semibold rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">Modifica</button>
            </div>
          </div>
        )}

        {showDetailSkeleton ? (
          <div className="p-4 space-y-4 animate-pulse">
            <div className="flex items-center gap-3">
              <div className="h-10 w-36 rounded-lg bg-purple-100" />
              <div className="h-4 w-28 rounded bg-gray-200" />
            </div>
            <div className="border rounded-xl bg-white p-4 space-y-3">
              <div className="h-4 w-28 rounded bg-gray-200" />
              <div className="h-3 w-4/5 rounded bg-gray-100" />
              <div className="h-10 w-full rounded-lg bg-gray-100" />
            </div>
            <div className="border rounded-xl bg-white overflow-hidden">
              <div className="px-4 py-3 border-b bg-gray-50">
                <div className="h-5 w-40 rounded bg-gray-200" />
              </div>
              <div className="divide-y">
                {Array.from({ length: 3 }).map((_, idx) => (
                  <div key={idx} className="grid grid-cols-[minmax(0,1fr)_90px_90px_80px_90px_180px_180px_140px] gap-3 px-4 py-4">
                    <div className="space-y-2">
                      <div className="h-4 w-3/4 rounded bg-gray-200" />
                      <div className="h-3 w-1/2 rounded bg-gray-100" />
                    </div>
                    <div className="h-4 rounded bg-gray-100" />
                    <div className="h-4 rounded bg-gray-100" />
                    <div className="h-4 rounded bg-gray-100" />
                    <div className="h-4 rounded bg-gray-100" />
                    <div className="h-8 rounded-lg bg-blue-50" />
                    <div className="h-8 rounded-lg bg-gray-100" />
                    <div className="h-8 rounded-lg bg-emerald-50" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <>
        {/* ═══ TAB: DETTAGLIO ═══ */}
        {activeTab === 'dettaglio' && (
          <div className="pt-1 pb-2 space-y-0">
            <div className="flex items-center gap-3 flex-wrap px-4">
              {aiClassifStatus === 'error' && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-red-600">Errore AI</span>
                  <button onClick={() => setAiClassifStatus('idle')} className="text-xs text-sky-600 hover:underline">Riprova</button>
                </div>
              )}



              {/* AI suggested banner */}
              {hasReviewableAiSuggestion && !aiClassifResult && (
                <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
                  <span className="text-amber-500 text-sm">{'\u26A1'}</span>
                  <span className="text-[10px] text-amber-800">Suggerimento AI {'\u2014'} verifica e Salva</span>
                </div>
              )}

              {/* Dirty indicator */}
              {isPostConfirmDirty && (
                <span className="text-[10px] text-amber-600 italic flex items-center gap-1 ml-auto">
                  <span>{'\u26A0'}</span> Non salvato
                </span>
              )}
            </div>



            {/* Invoice lines table with classification */}
            <div className="overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2 border-b border-slate-100">
                <span className="text-[11px] font-medium text-slate-500">
                  {classifiedLineCount}/{visibleLineCount - informationalTotal} classificate
                  {(hiddenLineCount > 0 || showZeroLines) && (
                    <button onClick={() => setShowZeroLines(!showZeroLines)}
                      className="ml-1.5 text-slate-400 hover:text-slate-600 underline">
                      {showZeroLines ? 'nascondi a zero' : `+${hiddenLineCount} a zero`}
                    </button>
                  )}
                </span>
                <span className="text-[10px] text-slate-400">
                  {visibleLineCount} righe
                  {informationalTotal > 0 && (
                    <span className="ml-1 text-slate-300">
                      ({groupedLineCount > 0 ? `${groupedLineCount} rif.` : ''}{groupedLineCount > 0 && skippedLineCount > 0 ? ', ' : ''}{skippedLineCount > 0 ? `${skippedLineCount} info` : ''})
                    </span>
                  )}
                </span>
              </div>
              <div className="overflow-hidden">
                <table className="w-full text-[11px]">
                  <thead className="bg-slate-50/50 text-left text-slate-500">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold w-[25%]">Descrizione</th>
                    <th className="text-right px-2 py-2 font-semibold w-12">Qt{'\u00E0'}</th>
                    <th className="text-right px-2 py-2 font-semibold w-16">P. Unit.</th>
                    <th className="text-right px-2 py-2 font-semibold w-12">IVA</th>
                    <th className="text-right px-2 py-2 font-semibold w-16">Totale</th>
                    {allCategories.length > 0 && (
                      <th className="text-center px-1 py-2 text-gray-600 font-semibold w-32">
                        <button data-header-dropdown-trigger onClick={(e) => openHeaderDropdown('category', e)}
                          className="hover:text-purple-600 transition-colors cursor-pointer inline-flex items-center gap-0.5"
                          title="Clicca per applicare a tutte le righe vuote">
                          Categoria <span className="text-[8px] text-gray-400">{'\u25BC'}</span>
                        </button>
                      </th>
                    )}
                    {allProjects.length > 0 && (
                      <th className="text-center px-1 py-2 text-gray-600 font-semibold w-28">
                        <button data-header-dropdown-trigger onClick={(e) => openHeaderDropdown('cdc', e)}
                          className="hover:text-purple-600 transition-colors cursor-pointer inline-flex items-center gap-0.5"
                          title="Clicca per applicare a tutte le righe vuote">
                          CdC <span className="text-[8px] text-gray-400">{'\u25BC'}</span>
                        </button>
                      </th>
                    )}
                    {allAccounts.length > 0 && (
                      <th className="text-center px-1 py-2 text-gray-600 font-semibold w-36">
                        <button data-header-dropdown-trigger onClick={(e) => openHeaderDropdown('account', e)}
                          className="hover:text-purple-600 transition-colors cursor-pointer inline-flex items-center gap-0.5"
                          title="Clicca per applicare a tutte le righe vuote">
                          Conto <span className="text-[8px] text-gray-400">{'\u25BC'}</span>
                        </button>
                      </th>
                    )}
                    {(allCategories.length > 0 || allAccounts.length > 0) && <th className="text-center px-0.5 py-2 font-normal w-10"></th>}
                    <th className="text-center px-2 py-2 font-semibold w-14">Conf.</th>
                    <th className="text-left px-2 py-2 font-semibold w-[25%]">Motivazione finale</th>
                    <th className="text-left px-2 py-2 font-semibold w-[15%]">Note</th>
                  </tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {/* Sort lines: classify lines first (with grouped children after parent), then skip lines */}
                    {(() => {
                      // Build sorted line list: parent → children → ... → skip at end
                      const allLines = visibleXmlLines.map((l: any, i: number) => ({
                        xml: l,
                        idx: i,
                        dbLine: detail?.invoice_lines?.find((dl: any) => dl.line_number === parseInt(l.numero || String(i + 1))),
                      }));

                      const sorted: typeof allLines = [];
                      const groupedByParent = new Map<string, typeof allLines>();

                      // Collect grouped lines by parent ID
                      for (const item of allLines) {
                        const lineId = item.dbLine?.id;
                        const action = lineId ? lineActions[lineId] : null;
                        if (action?.line_action === 'group' && action.grouped_with_line_id) {
                          const arr = groupedByParent.get(action.grouped_with_line_id) || [];
                          arr.push(item);
                          groupedByParent.set(action.grouped_with_line_id, arr);
                        }
                      }

                      // Add classify lines (with their grouped children after each)
                      for (const item of allLines) {
                        const lineId = item.dbLine?.id;
                        const action = lineId ? lineActions[lineId] : null;
                        if (!action || action.line_action === 'classify') {
                          sorted.push(item);
                          if (lineId) {
                            const children = groupedByParent.get(lineId) || [];
                            sorted.push(...children);
                          }
                        }
                      }

                      // Add skip lines at the end
                      for (const item of allLines) {
                        const lineId = item.dbLine?.id;
                        const action = lineId ? lineActions[lineId] : null;
                        if (action?.line_action === 'skip') {
                          sorted.push(item);
                        }
                      }

                      return sorted;
                    })().map(({ xml: l, idx: i, dbLine }: { xml: any; idx: number; dbLine: any }) => {
                      const lineId = dbLine?.id;
                      const lineAction = lineId ? lineActions[lineId] : null;
                      const isSkip = lineAction?.line_action === 'skip';
                      const isGroup = lineAction?.line_action === 'group';
                      const isInformational = isSkip || isGroup;
                      const lineCat = lineId ? lineClassifs[lineId]?.category_id : null;
                      const lineAcc = lineId ? lineClassifs[lineId]?.account_id : null;
                      const ff = lineId ? lineFiscalFlags[lineId] : null;
                      const colCount = 5 + (allCategories.length > 0 ? 1 : 0) + (allProjects.length > 0 ? 1 : 0) + (allAccounts.length > 0 ? 1 : 0) + ((allCategories.length > 0 || allAccounts.length > 0) ? 1 : 0) + 3;

                      // ─── Skip/Group informational lines: special rendering ───
                      if (isInformational) {
                        return (
                          <React.Fragment key={`info-${i}`}>
                            <tr className={`${isSkip ? 'bg-slate-50/50 opacity-50' : 'bg-blue-50/20'}`}>
                              <td className="text-left px-3 py-1.5">
                                {isGroup && <span className="text-slate-400 mr-1">{'\u21B3'}</span>}
                                <span className={`${isSkip ? 'text-slate-400 line-through' : 'text-slate-500 italic'}`}>
                                  {l.descrizione || '\u2014'}
                                </span>
                                <span className={`ml-1.5 inline-flex items-center text-[9px] px-1.5 py-0.5 rounded-full ${isSkip ? 'bg-gray-100 text-gray-400' : 'bg-blue-50 text-blue-400 border border-blue-100'}`}>
                                  {lineAction?.skip_reason || (isSkip ? 'Informativa' : 'Raggruppata')}
                                </span>
                                {/* Promote button: user can override AI's decision */}
                                {lineId && (
                                  <button
                                    onClick={async () => {
                                      try {
                                        await promoteLineToClassify(lineId);
                                        setLineActions(prev => { const next = { ...prev }; delete next[lineId]; return next; });
                                        toast.success('Riga promossa a contabile');
                                      } catch (e) {
                                        toast.error('Errore nel promuovere la riga');
                                      }
                                    }}
                                    title="Classifica questa riga (override AI)"
                                    className="ml-1.5 text-[9px] text-gray-400 hover:text-blue-600 hover:underline cursor-pointer"
                                  >
                                    Classifica
                                  </button>
                                )}
                              </td>
                              <td className="text-right px-2 py-1.5 text-gray-300">{l.quantita ? fmtNum(safeFloat(l.quantita)) : ''}</td>
                              <td className="text-right px-2 py-1.5 text-gray-300">{safeFloat(l.prezzoUnitario) ? fmtNum(safeFloat(l.prezzoUnitario)) : ''}</td>
                              <td className="text-right px-2 py-1.5 text-gray-300">{safeFloat(l.aliquotaIVA) ? `${fmtNum(safeFloat(l.aliquotaIVA))}%` : ''}</td>
                              <td className="text-right px-2 py-1.5 text-gray-300">{safeFloat(l.prezzoTotale) ? fmtNum(safeFloat(l.prezzoTotale)) : '0,00'}</td>
                              {/* Empty cells for category/cdc/account/actions columns */}
                              {allCategories.length > 0 && <td></td>}
                              {allProjects.length > 0 && <td></td>}
                              {allAccounts.length > 0 && <td></td>}
                              {(allCategories.length > 0 || allAccounts.length > 0) && <td></td>}
                              {/* Empty cells for Conf/Motivazione/Note columns */}
                              <td></td><td></td><td></td>
                            </tr>
                          </React.Fragment>
                        );
                      }

                      // ─── Normal classify line rendering ───
                      return (
                      <React.Fragment key={i}>
                      <tr className="hover:bg-slate-50/50">
                        <td className="text-left px-3 py-2.5 w-[25%]">
                          <div className="flex flex-col gap-1">
                            <span className="text-slate-800 leading-snug">{l.descrizione}</span>
                            {/* Badges row: fiscal flags + review badge + article */}
                            {lineId && (ff || lineReviewFlags[lineId] || articles.length > 0) && (
                              <div className="flex items-center gap-1.5 flex-wrap">
                                {ff && <FiscalFlagsBadges flags={ff} />}
                                <ReviewBadge
                                  confidence={lineConfidences[lineId]}
                                  hasNote={!!(ff?.note && /verificar|controllare|dubbio/i.test(ff.note || ''))}
                                  needsReview={lineReviewFlags[lineId]}
                                />
                                {articles.length > 0 && (
                                  <span className="inline-flex items-center gap-1 flex-wrap">
                                    <ArticleDropdown
                                      articles={articles}
                                      current={lineArticleMap[lineId] || null}
                                      suggestion={aiSuggestions[lineId] || null}
                                      onAssign={(artId, sugPhaseId) => handleAssignArticle(lineId, artId, l.descrizione || '', {
                                        quantity: safeFloat(l.quantita) || 1, unit_price: safeFloat(l.prezzoUnitario),
                                        total_price: safeFloat(l.prezzoTotale), vat_rate: safeFloat(l.aliquotaIVA),
                                      }, sugPhaseId)}
                                      onRemove={() => handleRemoveArticle(lineId)}
                                      onDismissSuggestion={() => handleDismissArticleSuggestion(lineId)}
                                    />
                                    {(() => {
                                      const info = lineArticleMap[lineId];
                                      if (!info) return null;
                                      const artWithPhases = articles.find(a => a.id === info.article_id);
                                      if (!artWithPhases?.phases?.length) return null;
                                      return (
                                        <PhaseDropdown
                                          phases={artWithPhases.phases}
                                          currentPhaseId={info.phase_id}
                                          onSelect={(phaseId) => handleAssignPhase(lineId, phaseId)}
                                        />
                                      );
                                    })()}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </td>
                        <td className={`text-right px-2 py-2.5 ${safeFloat(l.prezzoTotale) < 0 && lineId && lineArticleMap[lineId] ? 'text-slate-300 line-through' : 'text-slate-600'}`}>
                          {l.quantita ? fmtNum(safeFloat(l.quantita)) : '1'}
                          {safeFloat(l.prezzoTotale) < 0 && lineId && lineArticleMap[lineId] && (
                            <span title="Riga esclusa dal conteggio quantità (importo negativo — sconto/abbuono)" className="ml-0.5 text-red-400 text-[9px] cursor-help no-underline" style={{ textDecoration: 'none' }}>✕</span>
                          )}
                        </td>
                        <td className="text-right px-2 py-2.5 text-slate-600">{fmtNum(safeFloat(l.prezzoUnitario))}</td>
                        <td className="text-right px-2 py-2.5 text-slate-600">{fmtNum(safeFloat(l.aliquotaIVA))}%</td>
                        <td className={`text-right px-2 py-2.5 font-medium ${safeFloat(l.prezzoTotale) < 0 ? 'text-red-600' : 'text-slate-800'}`}>{fmtNum(safeFloat(l.prezzoTotale))}</td>
                        {allCategories.length > 0 && <td className={`text-center px-1 py-1${lineId && lineConfidences[lineId] != null && lineConfidences[lineId] < 50 ? ' opacity-40' : ''}`}>
                          {lineId ? (
                            <SearchableSelect
                              value={lineCat || null}
                              options={dirCategories.map(c => ({ id: c.id, label: c.name }))}
                              onChange={v => handleLineClassifChange(lineId, 'category_id', v)}
                              placeholder={selCategoryId ? '\u2190 Fatt.' : '\u2014'}
                              emptyLabel={selCategoryId ? '\u2190 Fatt.' : undefined}
                              selectedClassName="max-w-[120px]"
                              emptyClassName="max-w-[120px]"
                              truncate={18}
                            />
                          ) : <span className="text-[9px] text-gray-300">{'\u2014'}</span>}
                        </td>}
                        {allProjects.length > 0 && <td className="text-center px-1 py-1">
                          {lineId ? (
                              <button
                                onClick={(e) => {
                                  if (cdcPopoverLineId === lineId) { setCdcPopoverLineId(null); return; }
                                  const rect = e.currentTarget.getBoundingClientRect();
                                  const popW = 272;
                                  const overflowsRight = rect.left + popW > window.innerWidth - 8;
                                  setCdcPopoverPos({
                                    top: rect.bottom + 4,
                                    left: overflowsRight ? undefined : rect.left,
                                    right: overflowsRight ? Math.max(8, window.innerWidth - rect.right) : undefined,
                                  });
                                  setCdcPopoverLineId(lineId);
                                }}
                                title={lineProjects[lineId]?.length ? lineProjects[lineId].map(lp => { const p = allProjects.find(pp => pp.id === lp.project_id); return p ? `${p.code} ${p.name}` : ''; }).filter(Boolean).join(', ') : ''}
                                className={`text-[10px] hover:underline cursor-pointer w-full text-center px-1 py-1 rounded-md border ${
                                  lineProjects[lineId]?.length ? 'bg-indigo-50 border-indigo-200 text-indigo-700 font-semibold' : 'border-gray-200 text-gray-500'
                                }`}
                              >
                                {lineProjects[lineId]?.length
                                  ? lineProjects[lineId].map(lp => { const p = allProjects.find(pp => pp.id === lp.project_id); return p ? p.code : ''; }).filter(Boolean).join(', ').substring(0, 18)
                                  : (cdcRows.length > 0 ? '\u2190 Fatt.' : '\u2014')
                                }
                              </button>
                          ) : <span className="text-[9px] text-gray-300">{'\u2014'}</span>}
                        </td>}
                        {allAccounts.length > 0 && <td className={`text-center px-1 py-1${lineId && lineConfidences[lineId] != null && lineConfidences[lineId] < 50 ? ' opacity-40' : ''}`}>
                          {lineId ? (
                            <SearchableSelect
                              value={lineAcc || null}
                              options={[...dirPrimaryAccounts, ...dirSecondaryAccounts].map(a => ({ id: a.id, label: `${a.code} \u2014 ${a.name}`, searchText: `${a.code} ${a.name}` }))}
                              onChange={v => handleLineClassifChange(lineId, 'account_id', v)}
                              placeholder={selAccountId ? '\u2190 Fatt.' : '\u2014'}
                              emptyLabel={selAccountId ? '\u2190 Fatt.' : undefined}
                              selectedClassName="bg-emerald-50 border-emerald-200 text-emerald-700 font-semibold max-w-[120px]"
                              emptyClassName="border-gray-200 bg-white text-gray-500 max-w-[120px]"
                              truncate={20}
                            />
                          ) : <span className="text-[9px] text-gray-300">{'\u2014'}</span>}
                        </td>}
                        {/* Copy/Paste column */}
                        {(allCategories.length > 0 || allAccounts.length > 0) && <td className="text-center px-0.5 py-1 w-12">
                          {lineId && (
                            <div className="flex items-center gap-0.5 justify-center">
                              <button onClick={() => handleCopyLineClassif(lineId)}
                                title="Copia classificazione"
                                className="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50 text-[10px]">
                                {'\uD83D\uDCCB'}
                              </button>
                              {copiedClassif && (
                                <button onClick={() => handlePasteLineClassif(lineId)}
                                  title="Incolla classificazione"
                                  className="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-green-600 hover:bg-green-50 text-[10px]">
                                  {'\uD83D\uDCCC'}
                                </button>
                              )}
                            </div>
                          )}
                        </td>}
                        {/* Conf. column */}
                        <td className="text-center px-2 py-2.5">
                          {lineId && <ConfidenceBadge value={lineConfidences[lineId]} />}
                        </td>
                        {/* Motivazione finale column */}
                        <td className="text-left px-3 py-2.5 text-[11px] text-slate-500 w-[25%] break-words">
                          {lineId && (() => {
                            const finalReasoning = getFinalReasoningSummary(lineDetails[lineId]);
                            const pendingReason = getPendingDecisionReason(lineDetails[lineId]);
                            if (finalReasoning) {
                              return <span className="line-clamp-3 leading-relaxed">{finalReasoning}</span>;
                            }
                            if (pendingReason) {
                              return <span className="line-clamp-3 leading-relaxed italic text-amber-700">{pendingReason}</span>;
                            }
                            return null;
                          })()}
                        </td>
                        {/* Note column — clickable inline edit */}
                        <td className="text-left px-3 py-2.5 text-[11px] w-[15%]">
                          {lineId && editingNoteLineId === lineId ? (
                            <div className="flex flex-col gap-1">
                              <textarea
                                className="w-full text-[11px] border border-slate-200 rounded p-1.5 min-h-[40px] focus:outline-none focus:ring-1 focus:ring-purple-300 resize-y text-slate-700"
                                value={editingNoteText}
                                onChange={(e) => setEditingNoteText(e.target.value)}
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    handleSaveLineNote(lineId, editingNoteText);
                                    setLineDetails(prev => ({ ...prev, [lineId]: { ...prev[lineId], line_note: editingNoteText, line_note_source: 'user', line_note_updated_at: new Date().toISOString() } }));
                                    setEditingNoteLineId(null);
                                  }
                                  if (e.key === 'Escape') setEditingNoteLineId(null);
                                }}
                              />
                              <div className="flex gap-1">
                                <button onClick={() => { handleSaveLineNote(lineId, editingNoteText); setLineDetails(prev => ({ ...prev, [lineId]: { ...prev[lineId], line_note: editingNoteText, line_note_source: 'user', line_note_updated_at: new Date().toISOString() } })); setEditingNoteLineId(null); }}
                                  className="px-2 py-0.5 text-[10px] font-semibold rounded bg-blue-600 text-white hover:bg-blue-700">Salva</button>
                                <button onClick={() => setEditingNoteLineId(null)}
                                  className="px-2 py-0.5 text-[10px] font-semibold rounded border border-slate-200 text-slate-600 hover:bg-slate-50">Annulla</button>
                              </div>
                            </div>
                          ) : (
                            <div
                              className="cursor-pointer hover:bg-slate-50 rounded p-1 min-h-[24px] text-slate-600"
                              onClick={() => { if (lineId) { setEditingNoteLineId(lineId); setEditingNoteText(lineDetails[lineId]?.line_note || ''); } }}
                              title="Clicca per editare"
                            >
                              {lineId && lineDetails[lineId]?.line_note
                                ? <span className="line-clamp-3">{lineDetails[lineId].line_note}</span>
                                : <span className="italic text-slate-300 text-[10px]">+ Nota</span>}
                            </div>
                          )}
                        </td>
                      </tr>
                      {/* AI suggestion banner for new account/category */}
                      {lineId && lineSuggestions[lineId] && !dismissedSuggestions.has(lineId) && (
                        <tr>
                          <td colSpan={colCount} className="px-3 py-1.5">
                            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2">
                              <div className="flex items-center gap-1.5">
                                <span className="text-amber-500 text-xs">{'\uD83D\uDCA1'}</span>
                                <span className="text-[11px] font-semibold text-amber-800">L'AI suggerisce di creare:</span>
                              </div>
                              {lineSuggestions[lineId].suggest_new_account && (
                                <div className="text-[10px] text-amber-900 space-y-0.5 pl-5">
                                  <p className="font-medium">
                                    {'\uD83D\uDCCA'} Nuovo conto: &ldquo;{lineSuggestions[lineId].suggest_new_account!.name}&rdquo; ({lineSuggestions[lineId].suggest_new_account!.code})
                                  </p>
                                  <p className="text-amber-700">sotto: {lineSuggestions[lineId].suggest_new_account!.parent_code}</p>
                                  <p className="text-amber-600 italic">{lineSuggestions[lineId].suggest_new_account!.reason}</p>
                                </div>
                              )}
                              {lineSuggestions[lineId].suggest_new_category && (
                                <div className="text-[10px] text-amber-900 space-y-0.5 pl-5">
                                  <p className="font-medium">
                                    {'\uD83C\uDFF7\uFE0F'} Nuova categoria: &ldquo;{lineSuggestions[lineId].suggest_new_category!.name}&rdquo; ({lineSuggestions[lineId].suggest_new_category!.type})
                                  </p>
                                  <p className="text-amber-600 italic">{lineSuggestions[lineId].suggest_new_category!.reason}</p>
                                </div>
                              )}
                              <div className="flex gap-2 pl-5 pt-1">
                                <button onClick={() => handleCreateSuggestion(lineId)}
                                  disabled={creatingSuggestion === lineId}
                                  className="px-2.5 py-1 text-[10px] font-semibold rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
                                  {creatingSuggestion === lineId ? 'Creando...' : 'Crea e usa'}
                                </button>
                                <button onClick={() => handleDismissSuggestion(lineId)}
                                  className="px-2.5 py-1 text-[10px] font-semibold rounded bg-gray-200 text-gray-700 hover:bg-gray-300">
                                  Ignora
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                      );
                    })}
                    {/* Fallback: DB line items when XML not parsed */}
                    {!b?.linee?.length && (() => {
                      // Sort DB lines: classify first (with grouped children), skip at end
                      const allDbItems = visibleDbLines.map((l: any, i: number) => ({ line: l, idx: i }));
                      const sortedDb: typeof allDbItems = [];
                      const dbGroupedByParent = new Map<string, typeof allDbItems>();

                      for (const item of allDbItems) {
                        const action = lineActions[item.line.id];
                        if (action?.line_action === 'group' && action.grouped_with_line_id) {
                          const arr = dbGroupedByParent.get(action.grouped_with_line_id) || [];
                          arr.push(item);
                          dbGroupedByParent.set(action.grouped_with_line_id, arr);
                        }
                      }
                      for (const item of allDbItems) {
                        const action = lineActions[item.line.id];
                        if (!action || action.line_action === 'classify') {
                          sortedDb.push(item);
                          const children = dbGroupedByParent.get(item.line.id) || [];
                          sortedDb.push(...children);
                        }
                      }
                      for (const item of allDbItems) {
                        const action = lineActions[item.line.id];
                        if (action?.line_action === 'skip') sortedDb.push(item);
                      }

                      return sortedDb.map(({ line: l, idx: i }) => {
                      const lineAction = lineActions[l.id];
                      const isSkip = lineAction?.line_action === 'skip';
                      const isGroup = lineAction?.line_action === 'group';
                      const isInformational = isSkip || isGroup;
                      const lineCat = lineClassifs[l.id]?.category_id;
                      const lineAcc = lineClassifs[l.id]?.account_id;
                      const ff2 = lineFiscalFlags[l.id];
                      const colCount2 = 5 + (allCategories.length > 0 ? 1 : 0) + (allProjects.length > 0 ? 1 : 0) + (allAccounts.length > 0 ? 1 : 0) + ((allCategories.length > 0 || allAccounts.length > 0) ? 1 : 0) + 3;

                      // ─── Skip/Group informational lines: special rendering ───
                      if (isInformational) {
                        return (
                          <React.Fragment key={`db-info-${i}`}>
                            <tr className={`${isSkip ? 'bg-slate-50/50 opacity-50' : 'bg-blue-50/20'}`}>
                              <td className="text-left px-3 py-1.5">
                                {isGroup && <span className="text-slate-400 mr-1">{'\u21B3'}</span>}
                                <span className={`${isSkip ? 'text-slate-400 line-through' : 'text-slate-500 italic'}`}>
                                  {l.description || '\u2014'}
                                </span>
                                <span className={`ml-1.5 inline-flex items-center text-[9px] px-1.5 py-0.5 rounded-full ${isSkip ? 'bg-gray-100 text-gray-400' : 'bg-blue-50 text-blue-400 border border-blue-100'}`}>
                                  {lineAction?.skip_reason || (isSkip ? 'Informativa' : 'Raggruppata')}
                                </span>
                                <button
                                  onClick={async () => {
                                    try {
                                      await promoteLineToClassify(l.id);
                                      setLineActions(prev => { const next = { ...prev }; delete next[l.id]; return next; });
                                      toast.success('Riga promossa a contabile');
                                    } catch (e) {
                                      toast.error('Errore nel promuovere la riga');
                                    }
                                  }}
                                  title="Classifica questa riga (override AI)"
                                  className="ml-1.5 text-[9px] text-gray-400 hover:text-blue-600 hover:underline cursor-pointer"
                                >
                                  Classifica
                                </button>
                              </td>
                              <td className="text-right px-2 py-1.5 text-gray-300">{fmtNum(l.quantity)}</td>
                              <td className="text-right px-2 py-1.5 text-gray-300">{l.unit_price ? fmtNum(l.unit_price) : ''}</td>
                              <td className="text-right px-2 py-1.5 text-gray-300">{l.vat_rate ? `${fmtNum(l.vat_rate)}%` : ''}</td>
                              <td className="text-right px-2 py-1.5 text-gray-300">{l.total_price ? fmtNum(l.total_price) : '0,00'}</td>
                              {allCategories.length > 0 && <td></td>}
                              {allProjects.length > 0 && <td></td>}
                              {allAccounts.length > 0 && <td></td>}
                              {(allCategories.length > 0 || allAccounts.length > 0) && <td></td>}
                              {/* Empty cells for Conf/Motivazione/Note columns */}
                              <td></td><td></td><td></td>
                            </tr>
                          </React.Fragment>
                        );
                      }

                      // ─── Normal classify line rendering ───
                      return (
                      <React.Fragment key={i}>
                      <tr className="hover:bg-slate-50/50">
                        <td className="text-left px-3 py-2.5 min-w-[240px]">
                          <div className="flex flex-col gap-1">
                            <span className="text-slate-800 leading-snug">{l.description}</span>
                            {(ff2 || lineReviewFlags[l.id] || articles.length > 0) && (
                              <div className="flex items-center gap-1.5 flex-wrap">
                                {ff2 && <FiscalFlagsBadges flags={ff2} />}
                                <ReviewBadge
                                  confidence={lineConfidences[l.id]}
                                  hasNote={!!(ff2?.note && /verificar|controllare|dubbio/i.test(ff2.note || ''))}
                                  needsReview={lineReviewFlags[l.id]}
                                />
                                {articles.length > 0 && (
                                  <span className="inline-flex items-center gap-1 flex-wrap">
                                    <ArticleDropdown articles={articles} current={lineArticleMap[l.id] || null} suggestion={aiSuggestions[l.id] || null}
                                      onAssign={(artId, sugPhaseId) => handleAssignArticle(l.id, artId, l.description, { quantity: l.quantity, unit_price: l.unit_price, total_price: l.total_price, vat_rate: l.vat_rate }, sugPhaseId)}
                                      onRemove={() => handleRemoveArticle(l.id)}
                                      onDismissSuggestion={() => handleDismissArticleSuggestion(l.id)} />
                                    {(() => {
                                      const info = lineArticleMap[l.id];
                                      if (!info) return null;
                                      const artWithPhases = articles.find(a => a.id === info.article_id);
                                      if (!artWithPhases?.phases?.length) return null;
                                      return (
                                        <PhaseDropdown
                                          phases={artWithPhases.phases}
                                          currentPhaseId={info.phase_id}
                                          onSelect={(phaseId) => handleAssignPhase(l.id, phaseId)}
                                        />
                                      );
                                    })()}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </td>
                        <td className={`text-right px-2 py-2.5 ${(l.total_price ?? 0) < 0 && lineArticleMap[l.id] ? 'text-slate-300 line-through' : 'text-slate-600'}`}>
                          {fmtNum(l.quantity)}
                          {(l.total_price ?? 0) < 0 && lineArticleMap[l.id] && (
                            <span title="Riga esclusa dal conteggio quantità (importo negativo — sconto/abbuono)" className="ml-0.5 text-red-400 text-[9px] cursor-help no-underline" style={{ textDecoration: 'none' }}>✕</span>
                          )}
                        </td>
                        <td className="text-right px-2 py-2.5 text-slate-600">{fmtNum(l.unit_price)}</td>
                        <td className="text-right px-2 py-2.5 text-slate-600">{fmtNum(l.vat_rate)}%</td>
                        <td className={`text-right px-2 py-2.5 font-medium ${(l.total_price ?? 0) < 0 ? 'text-red-600' : 'text-slate-800'}`}>{fmtNum(l.total_price)}</td>
                        {allCategories.length > 0 && <td className={`text-center px-1 py-1${lineConfidences[l.id] != null && lineConfidences[l.id] < 50 ? ' opacity-40' : ''}`}>
                          <SearchableSelect
                            value={lineCat || null}
                            options={allCategories.map(c => ({ id: c.id, label: c.name }))}
                            onChange={v => handleLineClassifChange(l.id, 'category_id', v)}
                            placeholder={selCategoryId ? '\u2190 Fatt.' : '\u2014'}
                            emptyLabel={selCategoryId ? '\u2190 Fatt.' : undefined}
                            truncate={18}
                          />
                        </td>}
                        {allProjects.length > 0 && <td className="text-center px-1 py-1">
                          <button onClick={(e) => {
                              if (cdcPopoverLineId === l.id) { setCdcPopoverLineId(null); return; }
                              const rect = e.currentTarget.getBoundingClientRect();
                              const popW = 272;
                              const overflowsRight = rect.left + popW > window.innerWidth - 8;
                              setCdcPopoverPos({
                                top: rect.bottom + 4,
                                left: overflowsRight ? undefined : rect.left,
                                right: overflowsRight ? Math.max(8, window.innerWidth - rect.right) : undefined,
                              });
                              setCdcPopoverLineId(l.id);
                            }}
                            title={lineProjects[l.id]?.length ? lineProjects[l.id].map(lp => { const p = allProjects.find(pp => pp.id === lp.project_id); return p ? `${p.code} ${p.name}` : ''; }).filter(Boolean).join(', ') : ''}
                            className={`text-[10px] cursor-pointer w-full text-center px-1 py-1 rounded-md border ${lineProjects[l.id]?.length ? 'bg-indigo-50 border-indigo-200 text-indigo-700 font-semibold' : 'border-gray-200 text-gray-500'}`}>
                            {lineProjects[l.id]?.length ? lineProjects[l.id].map(lp => { const p = allProjects.find(pp => pp.id === lp.project_id); return p ? `${p.code} ${p.name?.substring(0, 8) || ''}` : ''; }).filter(Boolean).join(', ').substring(0, 18) : (cdcRows.length > 0 ? '\u2190 Fatt.' : '\u2014')}
                          </button>
                        </td>}
                        {allAccounts.length > 0 && <td className={`text-center px-1 py-1${lineConfidences[l.id] != null && lineConfidences[l.id] < 50 ? ' opacity-40' : ''}`}>
                          <SearchableSelect
                            value={lineAcc || null}
                            options={allAccounts.map(a => ({ id: a.id, label: `${a.code} \u2014 ${a.name}`, searchText: `${a.code} ${a.name}` }))}
                            onChange={v => handleLineClassifChange(l.id, 'account_id', v)}
                            placeholder={selAccountId ? '\u2190 Fatt.' : '\u2014'}
                            emptyLabel={selAccountId ? '\u2190 Fatt.' : undefined}
                            selectedClassName="bg-emerald-50 border-emerald-200 text-emerald-700 font-semibold"
                            emptyClassName="border-gray-200 bg-white text-gray-500"
                            truncate={20}
                          />
                        </td>}
                        {/* Copy/Paste column */}
                        {(allCategories.length > 0 || allAccounts.length > 0) && <td className="text-center px-0.5 py-1 w-12">
                          <div className="flex items-center gap-0.5 justify-center">
                            <button onClick={() => handleCopyLineClassif(l.id)}
                              title="Copia classificazione"
                              className="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50 text-[10px]">
                              {'\uD83D\uDCCB'}
                            </button>
                            {copiedClassif && (
                              <button onClick={() => handlePasteLineClassif(l.id)}
                                title="Incolla classificazione"
                                className="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-green-600 hover:bg-green-50 text-[10px]">
                                {'\uD83D\uDCCC'}
                              </button>
                            )}
                          </div>
                        </td>}
                        {/* Conf. column */}
                        <td className="text-center px-2 py-2.5">
                          <ConfidenceBadge value={lineConfidences[l.id]} />
                        </td>
                        {/* Motivazione finale column */}
                        <td className="text-left px-3 py-2.5 text-[11px] text-slate-500 min-w-[180px]">
                          {(() => {
                            const finalReasoning = getFinalReasoningSummary(lineDetails[l.id]);
                            const pendingReason = getPendingDecisionReason(lineDetails[l.id]);
                            if (finalReasoning) {
                              return <span className="line-clamp-3 leading-relaxed">{finalReasoning}</span>;
                            }
                            if (pendingReason) {
                              return <span className="line-clamp-3 leading-relaxed italic text-amber-700">{pendingReason}</span>;
                            }
                            return null;
                          })()}
                        </td>
                        {/* Note column — clickable inline edit */}
                        <td className="text-left px-3 py-2.5 text-[11px] min-w-[100px]">
                          {editingNoteLineId === l.id ? (
                            <div className="flex flex-col gap-1">
                              <textarea
                                className="w-full text-[11px] border border-slate-200 rounded p-1.5 min-h-[40px] focus:outline-none focus:ring-1 focus:ring-purple-300 resize-y text-slate-700"
                                value={editingNoteText}
                                onChange={(e) => setEditingNoteText(e.target.value)}
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    handleSaveLineNote(l.id, editingNoteText);
                                    setLineDetails(prev => ({ ...prev, [l.id]: { ...prev[l.id], line_note: editingNoteText, line_note_source: 'user', line_note_updated_at: new Date().toISOString() } }));
                                    setEditingNoteLineId(null);
                                  }
                                  if (e.key === 'Escape') setEditingNoteLineId(null);
                                }}
                              />
                              <div className="flex gap-1">
                                <button onClick={() => { handleSaveLineNote(l.id, editingNoteText); setLineDetails(prev => ({ ...prev, [l.id]: { ...prev[l.id], line_note: editingNoteText, line_note_source: 'user', line_note_updated_at: new Date().toISOString() } })); setEditingNoteLineId(null); }}
                                  className="px-2 py-0.5 text-[10px] font-semibold rounded bg-blue-600 text-white hover:bg-blue-700">Salva</button>
                                <button onClick={() => setEditingNoteLineId(null)}
                                  className="px-2 py-0.5 text-[10px] font-semibold rounded border border-slate-200 text-slate-600 hover:bg-slate-50">Annulla</button>
                              </div>
                            </div>
                          ) : (
                            <div
                              className="cursor-pointer hover:bg-slate-50 rounded p-1 min-h-[24px] text-slate-600"
                              onClick={() => { setEditingNoteLineId(l.id); setEditingNoteText(lineDetails[l.id]?.line_note || ''); }}
                              title="Clicca per editare"
                            >
                              {lineDetails[l.id]?.line_note
                                ? <span className="line-clamp-3">{lineDetails[l.id].line_note}</span>
                                : <span className="italic text-slate-300 text-[10px]">+ Nota</span>}
                            </div>
                          )}
                        </td>
                      </tr>
                      {/* AI suggestion banner for new account/category (DB fallback lines) */}
                      {lineSuggestions[l.id] && !dismissedSuggestions.has(l.id) && (
                        <tr>
                          <td colSpan={colCount2} className="px-3 py-1.5">
                            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2">
                              <div className="flex items-center gap-1.5">
                                <span className="text-amber-500 text-xs">{'\uD83D\uDCA1'}</span>
                                <span className="text-[11px] font-semibold text-amber-800">L'AI suggerisce di creare:</span>
                              </div>
                              {lineSuggestions[l.id].suggest_new_account && (
                                <div className="text-[10px] text-amber-900 space-y-0.5 pl-5">
                                  <p className="font-medium">
                                    {'\uD83D\uDCCA'} Nuovo conto: &ldquo;{lineSuggestions[l.id].suggest_new_account!.name}&rdquo; ({lineSuggestions[l.id].suggest_new_account!.code})
                                  </p>
                                  <p className="text-amber-700">sotto: {lineSuggestions[l.id].suggest_new_account!.parent_code}</p>
                                  <p className="text-amber-600 italic">{lineSuggestions[l.id].suggest_new_account!.reason}</p>
                                </div>
                              )}
                              {lineSuggestions[l.id].suggest_new_category && (
                                <div className="text-[10px] text-amber-900 space-y-0.5 pl-5">
                                  <p className="font-medium">
                                    {'\uD83C\uDFF7\uFE0F'} Nuova categoria: &ldquo;{lineSuggestions[l.id].suggest_new_category!.name}&rdquo; ({lineSuggestions[l.id].suggest_new_category!.type})
                                  </p>
                                  <p className="text-amber-600 italic">{lineSuggestions[l.id].suggest_new_category!.reason}</p>
                                </div>
                              )}
                              <div className="flex gap-2 pl-5 pt-1">
                                <button onClick={() => handleCreateSuggestion(l.id)}
                                  disabled={creatingSuggestion === l.id}
                                  className="px-2.5 py-1 text-[10px] font-semibold rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
                                  {creatingSuggestion === l.id ? 'Creando...' : 'Crea e usa'}
                                </button>
                                <button onClick={() => handleDismissSuggestion(l.id)}
                                  className="px-2.5 py-1 text-[10px] font-semibold rounded bg-gray-200 text-gray-700 hover:bg-gray-300">
                                  Ignora
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                      );
                    });
                    })()}
                  </tbody>
                </table>
              </div>
              {/* Portal dropdown for header column popovers — escapes overflow container */}
              {headerDropdown && headerDropdownRect && createPortal(
                <div ref={headerDropdownRef}
                  className="fixed z-[9999] w-72 bg-white border border-gray-200 rounded-lg shadow-xl flex flex-col"
                  style={{
                    top: headerDropdownRect.bottom + 4,
                    left: headerDropdown === 'account'
                      ? Math.max(8, headerDropdownRect.right - 288)
                      : headerDropdownRect.left,
                    maxHeight: Math.min(420, window.innerHeight - headerDropdownRect.bottom - 16),
                  }}>
                  {/* Sticky header with search */}
                  <div className="sticky top-0 bg-white border-b z-10 rounded-t-lg">
                    <div className="px-2 py-1 text-[9px] text-gray-400 bg-gray-50 rounded-t-lg">Applica a righe vuote</div>
                    <div className="px-2 py-1.5">
                      <input
                        ref={headerDropdownSearchRef}
                        type="text"
                        value={headerDropdownSearch}
                        onChange={e => setHeaderDropdownSearch(e.target.value)}
                        className="w-full px-2 py-1 text-[11px] border border-gray-200 rounded focus:ring-1 focus:ring-purple-400 outline-none"
                        placeholder={
                          headerDropdown === 'category' ? 'Cerca categoria...' :
                          headerDropdown === 'cdc' ? 'Cerca CdC...' :
                          'Cerca conto (nome o codice)...'
                        }
                      />
                    </div>
                  </div>
                  {/* Scrollable list */}
                  <div className="overflow-y-auto flex-1">
                  {headerDropdown === 'category' && (() => {
                    const q = headerDropdownSearch.toLowerCase().trim();
                    const filtered = q ? dirCategories.filter(c => c.name.toLowerCase().includes(q)) : dirCategories;
                    return filtered.length > 0 ? filtered.map(c => (
                      <button key={c.id} onClick={() => { handleHeaderApplyCategory(c.id); setHeaderDropdown(null); }}
                        className="w-full text-left px-2 py-1.5 text-[10px] hover:bg-purple-50 hover:text-purple-700 transition-colors truncate">
                        {c.name}
                      </button>
                    )) : <div className="px-2 py-3 text-[10px] text-gray-400 text-center">Nessun risultato</div>;
                  })()}
                  {headerDropdown === 'cdc' && (() => {
                    const q = headerDropdownSearch.toLowerCase().trim();
                    const filtered = q ? allProjects.filter(p =>
                      p.code.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
                    ) : allProjects;
                    return filtered.length > 0 ? filtered.map(p => (
                      <button key={p.id} onClick={() => { handleHeaderApplyCdc(p.id); setHeaderDropdown(null); }}
                        className="w-full text-left px-2 py-1.5 text-[10px] hover:bg-purple-50 hover:text-purple-700 transition-colors truncate">
                        {p.code} {'\u2014'} {p.name}
                      </button>
                    )) : <div className="px-2 py-3 text-[10px] text-gray-400 text-center">Nessun risultato</div>;
                  })()}
                  {headerDropdown === 'account' && (() => {
                    const q = headerDropdownSearch.toLowerCase().trim();
                    const filterAcc = (a: typeof dirPrimaryAccounts[0]) =>
                      !q || a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q);
                    const filteredPrimary = dirPrimaryAccounts.filter(filterAcc);
                    const filteredSecondary = dirSecondaryAccounts.filter(filterAcc);
                    const total = filteredPrimary.length + filteredSecondary.length;
                    if (total === 0) return <div className="px-2 py-3 text-[10px] text-gray-400 text-center">Nessun risultato</div>;
                    return (<>
                      {filteredPrimary.map(a => (
                        <button key={a.id} onClick={() => { handleHeaderApplyAccount(a.id); setHeaderDropdown(null); }}
                          className="w-full text-left px-2 py-1.5 text-[10px] hover:bg-purple-50 hover:text-purple-700 transition-colors truncate">
                          {a.code} {'\u2014'} {a.name}
                        </button>
                      ))}
                      {filteredSecondary.length > 0 && (
                        <div className="px-2 py-1 text-[9px] text-gray-400 border-t bg-gray-50 sticky">Speciali</div>
                      )}
                      {filteredSecondary.map(a => (
                        <button key={a.id} onClick={() => { handleHeaderApplyAccount(a.id); setHeaderDropdown(null); }}
                          className="w-full text-left px-2 py-1.5 text-[10px] hover:bg-purple-50 hover:text-purple-700 transition-colors truncate">
                          {a.code} {'\u2014'} {a.name}
                        </button>
                      ))}
                    </>);
                  })()}
                  </div>
                </div>,
                document.body
              )}
              {/* Footer — sticky save bar */}
              <div className="sticky bottom-0 z-10 flex items-center justify-between px-4 py-2.5 border-t border-slate-200 bg-white/95 backdrop-blur-sm">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-slate-400">
                    {isPostConfirmDirty
                      ? '\u26A0 Modifiche non salvate'
                      : isConfirmed
                        ? '\u2713 Classificazione confermata'
                        : classification
                          ? '\u2713 Classificazione salvata'
                          : 'Nessuna classificazione'}
                  </span>
                  {(persistedHasData || draftHasData || clearPending) && (
                    <button onClick={() => setShowClearDialog(true)}
                      className="px-4 py-1.5 text-xs font-medium rounded-full border border-slate-200 text-slate-600 bg-white hover:bg-slate-50 transition-colors">
                      Cancella tutto
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {isPostConfirmDirty && (
                    <button onClick={handleConfirmChanges} disabled={confirmChangesSaving || !cdcValidation.valid}
                      className="px-5 py-1.5 text-xs font-semibold rounded-full bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                      title={!cdcValidation.valid ? cdcValidation.message : 'Salva tutte le modifiche'}>
                      {confirmChangesSaving ? 'Salvataggio...' : 'Salva'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* CdC line popover — Portal-rendered to escape overflow-hidden table */}
        {cdcPopoverLineId && createPortal(
          <div
            ref={cdcPopoverRef}
            style={{
              position: 'fixed',
              top: cdcPopoverPos.top,
              left: cdcPopoverPos.left,
              right: cdcPopoverPos.right,
              zIndex: 9999,
            }}
            className="bg-white border border-gray-200 rounded-lg shadow-2xl p-3 w-[272px]"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-semibold text-gray-700">CdC Riga</span>
              <button onClick={() => setCdcPopoverLineId(null)} className="text-gray-400 hover:text-gray-600 text-xs">✕</button>
            </div>
            {(lineProjects[cdcPopoverLineId] || []).map((lp, lpIdx) => {
              const proj = allProjects.find(p => p.id === lp.project_id);
              return (
                <div key={lp.id || lpIdx} className="flex items-center gap-1 mb-1">
                  <span className="text-[9px] text-gray-600 flex-1 truncate">{proj?.code} {proj?.name}</span>
                  <input type="number" min={0} max={100} step={1}
                    value={lp.percentage}
                    onChange={e => {
                      const pct = Math.max(0, Math.min(100, Number(e.target.value)));
                      const lid = cdcPopoverLineId;
                      setLineProjects(prev => ({
                        ...prev,
                        [lid]: (prev[lid] || []).map((r, ri) => ri === lpIdx ? { ...r, percentage: pct } : r),
                      }));
                    }}
                    className="w-12 text-[9px] text-right border rounded px-1 py-0.5"
                  />
                  <span className="text-[9px] text-gray-400">%</span>
                  <button onClick={() => {
                    const lid = cdcPopoverLineId;
                    setLineProjects(prev => ({
                      ...prev,
                      [lid]: (prev[lid] || []).filter((_, ri) => ri !== lpIdx),
                    }));
                  }} className="text-red-400 hover:text-red-600 text-[9px]">✕</button>
                </div>
              );
            })}
            {(() => {
              const lps = lineProjects[cdcPopoverLineId] || [];
              if (lps.length <= 1) return null;
              const total = lps.reduce((s, p) => s + p.percentage, 0);
              const isValid = Math.abs(total - 100) < 0.01;
              return !isValid ? (
                <div className="text-[9px] text-red-600 font-medium mt-1">
                  ⚠ Percentuali devono sommare a 100% (attuale: {Math.round(total)}%)
                </div>
              ) : null;
            })()}
            <div className="flex items-center gap-1 mt-1">
              <select className="flex-1 text-[9px] border rounded px-1 py-0.5" value=""
                onChange={e => {
                  if (!e.target.value) return;
                  const lid = cdcPopoverLineId;
                  const existing = lineProjects[lid] || [];
                  if (existing.length === 1 && existing[0].percentage === 100) {
                    setLineProjects(prev => ({
                      ...prev,
                      [lid]: [
                        { ...existing[0], percentage: 50 },
                        { id: crypto.randomUUID(), invoice_line_id: lid, project_id: e.target.value, percentage: 50, amount: null },
                      ],
                    }));
                  } else {
                    setLineProjects(prev => ({
                      ...prev,
                      [lid]: [...existing, { id: crypto.randomUUID(), invoice_line_id: lid, project_id: e.target.value, percentage: 100, amount: null }],
                    }));
                  }
                }}>
                <option value="">+ Aggiungi CdC</option>
                {allProjects.filter(p => !(lineProjects[cdcPopoverLineId] || []).some(lp => lp.project_id === p.id)).map(p => (
                  <option key={p.id} value={p.id}>{p.code} - {p.name}</option>
                ))}
              </select>
            </div>
          </div>,
          document.body,
        )}

        {/* Clear classification confirmation dialog */}
        {showClearDialog && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
            <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
              <p className="font-semibold text-gray-900 mb-2">Cancella classificazione</p>
              <p className="text-sm text-gray-500 mb-4">
                Vuoi cancellare tutta la classificazione di questa fattura?
                Categoria, CdC, Conto e Articolo verranno rimossi da tutte le righe.
              </p>
              <div className="flex gap-3 justify-end">
                <button onClick={() => setShowClearDialog(false)}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100">
                  Annulla
                </button>
                <button onClick={handleClearAllClassification}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-red-600 text-white hover:bg-red-700">
                  Cancella tutto
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Rules dialog: choice between fast-path rules or fresh AI */}
        {showRulesDialog && pendingRuleSuggestions.length > 0 && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
            <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
              <p className="font-semibold text-gray-900 mb-2">Regole trovate</p>
              <p className="text-sm text-gray-500 mb-4">
                Trovate {pendingRuleSuggestions.length} regole da classificazioni precedenti per questa controparte.
                Vuoi applicarle o reclassificare con l'AI?
              </p>
              <div className="flex gap-3 justify-end">
                <button onClick={() => { setShowRulesDialog(false); setPendingRuleSuggestions([]); }}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100">
                  Annulla
                </button>
                <button onClick={() => runAiClassification(false)}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-green-600 text-green-700 hover:bg-green-50">
                  Usa regole
                </button>
                <button onClick={() => runAiClassification(true)}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-gradient-to-r from-purple-600 to-indigo-600 text-white hover:from-purple-700 hover:to-indigo-700">
                  Reclassifica con AI
                </button>
              </div>
            </div>
          </div>
        )}

        {/* TAB: DOCUMENTO */}
        {activeTab === 'documento' && (
          <div className="p-4 space-y-4">
            {/* Da / Per */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-white border rounded-xl p-4">
                <h4 className="text-[10px] font-bold text-red-600 mb-2">Da:</h4>
                <p className="text-sm font-bold text-gray-900 mb-2">{d?.ced?.denom || cp?.denom || 'N/D'}</p>
                <Row l="P.IVA" v={d?.ced?.piva || cp?.piva} />
                <Row l="Codice Fiscale" v={d?.ced?.cf || cp?.cf} />
                <Row l="Regime Fiscale" v={d?.ced?.regime ? `${d.ced.regime} (${REG[d.ced.regime] || ''})` : undefined} />
                <Row l="Sede" v={d?.ced?.sede || cp?.sede} />
                <Row l="Iscrizione REA" v={d?.ced?.reaNumero ? `${d.ced.reaUfficio} ${d.ced.reaNumero}` : undefined} />
                <Row l="Capitale Sociale" v={d?.ced?.capitale ? fmtEur(safeFloat(d.ced.capitale)) : undefined} />
                <Row l="In Liquidazione" v={d?.ced?.liquidazione === 'LN' ? 'LN (No)' : d?.ced?.liquidazione === 'LS' ? 'LS (S\u00ec)' : d?.ced?.liquidazione || undefined} />
                <Row l="Telefono" v={d?.ced?.tel} />
                <Row l="Email" v={d?.ced?.email} />
              </div>
              <div className="bg-white border rounded-xl p-4">
                <h4 className="text-[10px] font-bold text-blue-600 mb-2">Per:</h4>
                <p className="text-sm font-bold text-gray-900 mb-2">{d?.ces?.denom || 'N/D'}</p>
                <Row l="P.IVA" v={d?.ces?.piva} />
                <Row l="Codice Fiscale" v={d?.ces?.cf} />
                <Row l="Sede" v={d?.ces?.sede} />
              </div>
            </div>

            {/* Riferimenti */}
            {hasRefs && (
              <div className="bg-white border rounded-xl p-4">
                <h4 className="text-xs font-bold text-gray-700 mb-2">Riferimenti</h4>
                {b.contratti?.map((c: any, i: number) => <Row key={`c${i}`} l="Rif. Contratto" v={[c.id, c.data ? fmtDate(c.data) : '', c.cig ? `CIG:${c.cig}` : '', c.cup ? `CUP:${c.cup}` : ''].filter(Boolean).join(' \u2014 ')} />)}
                {b.ordini?.map((o: any, i: number) => <Row key={`o${i}`} l="Rif. Ordine" v={[o.id, o.data ? fmtDate(o.data) : '', o.cig ? `CIG:${o.cig}` : '', o.cup ? `CUP:${o.cup}` : ''].filter(Boolean).join(' \u2014 ')} />)}
                {b.convenzioni?.map((c: any, i: number) => <Row key={`v${i}`} l="Rif. Convenzione" v={[c.id, c.data ? fmtDate(c.data) : ''].filter(Boolean).join(' \u2014 ')} />)}
              </div>
            )}

            {/* Dettaglio Beni e Servizi — removed: lines are shown in Dettaglio tab */}

            {/* Riepilogo IVA + Totale */}
            {b?.riepilogo?.length > 0 && (
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-white border rounded-xl p-4">
                  <h4 className="text-xs font-bold text-gray-700 mb-2">Riepilogo IVA</h4>
                  {b.riepilogo.map((r: any, i: number) => (
                    <div key={i} className="flex justify-between py-0.5 text-xs">
                      <span className="text-gray-600">Aliquota {fmtNum(safeFloat(r.aliquota))}%{r.natura ? ` - ${NAT[r.natura] || r.natura}` : ''}</span>
                      <span className="font-semibold">Imposta: {fmtNum(safeFloat(r.imposta))} {'\u20AC'} {'\u2014'} Imponibile: {fmtNum(safeFloat(r.imponibile))} {'\u20AC'}</span>
                    </div>
                  ))}
                </div>
                <div className="bg-white border rounded-xl p-4 flex flex-col justify-center items-center">
                  <h4 className="text-xs font-bold text-gray-700 mb-1">Totale Documento</h4>
                  <div className={`text-2xl font-extrabold ${nc ? 'text-red-600' : 'text-emerald-700'}`}>
                    {fmtEur((() => {
                      const fromXml = safeFloat(b.totale);
                      if (fromXml !== 0) return fromXml;
                      const base = b.riepilogo?.reduce((s: number, r: any) => s + safeFloat(r.imponibile) + safeFloat(r.imposta), 0) || 0;
                      return base;
                    })())}
                  </div>
                  <div className="text-[10px] text-gray-500 mt-1">
                    Divisa: {b.divisa || 'EUR'} {'\u2014'} Bollo: {b.bollo?.importo ? fmtEur(safeFloat(b.bollo.importo)) : '0,00'}
                  </div>
                </div>
              </div>
            )}

            {/* DDT */}
            {b?.ddt?.length > 0 && (
              <div className="bg-white border rounded-xl p-4">
                <h4 className="text-xs font-bold text-gray-700 mb-2">Documenti di Trasporto</h4>
                {b.ddt.map((dd: any, i: number) => <div key={i}><Row l="DDT Numero" v={dd.numero} /><Row l="DDT Data" v={fmtDate(dd.data)} /></div>)}
              </div>
            )}

            {/* Ritenuta */}
            {b?.ritenuta?.importo && (
              <div className="bg-white border rounded-xl p-4">
                <h4 className="text-xs font-bold text-gray-700 mb-2">Ritenuta d'Acconto</h4>
                <Row l="Tipo" v={RIT[b.ritenuta.tipo] || b.ritenuta.tipo} />
                <Row l="Importo" v={fmtEur(safeFloat(b.ritenuta.importo))} accent />
                <Row l="Aliquota" v={b.ritenuta.aliquota ? `${fmtNum(safeFloat(b.ritenuta.aliquota))}%` : undefined} />
                <Row l="Causale Pag." v={b.ritenuta.causale} />
              </div>
            )}

            {/* Cassa */}
            {b?.cassa?.importo && (
              <div className="bg-white border rounded-xl p-4">
                <h4 className="text-xs font-bold text-gray-700 mb-2">Cassa Previdenziale</h4>
                <Row l="Tipo Cassa" v={b.cassa.tipo} />
                <Row l="Importo Contributo" v={fmtEur(safeFloat(b.cassa.importo))} accent />
                <Row l="Aliquota" v={b.cassa.al ? `${fmtNum(safeFloat(b.cassa.al))}%` : undefined} />
              </div>
            )}

            {/* Allegati */}
            {b?.allegati?.length > 0 && (
              <div className="bg-white border rounded-xl overflow-hidden">
                <h4 className="text-xs font-bold text-gray-700 px-4 py-2.5 border-b bg-gray-50">File Allegati</h4>
                <table className="w-full border-collapse text-[11px]">
                  <thead><tr className="bg-slate-50/50 border-b">
                    <th className="text-left px-3 py-1.5 text-gray-600 font-semibold">Nome</th>
                    <th className="text-left px-2 py-1.5 text-gray-600 font-semibold">Formato</th>
                    <th className="text-right px-2 py-1.5 text-gray-600 font-semibold">Dim.</th>
                    <th className="text-right px-3 py-1.5 text-gray-600 font-semibold">Scarica</th>
                  </tr></thead>
                  <tbody>
                    {b.allegati.map((a: any, i: number) => (
                      <tr key={i} className="border-b border-gray-50">
                        <td className="text-left px-3 py-1.5 text-sky-700">{a.nome}</td>
                        <td className="text-left px-2 py-1.5">{a.formato || '\u2014'}</td>
                        <td className="text-right px-2 py-1.5">{a.sizeKB > 0 ? `${a.sizeKB} KB` : '\u2014'}</td>
                        <td className="text-right px-3 py-1.5">{a.hasData ? <button onClick={() => downloadAllegato(a)} className="bg-sky-600 text-white border-none rounded px-2 py-0.5 text-[10px] cursor-pointer font-semibold hover:bg-sky-700">{'\u2B07'} Scarica</button> : '\u2014'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Trasmissione */}
            {d?.trasm && (
              <div className="bg-white border rounded-xl p-4">
                <h4 className="text-xs font-bold text-gray-700 mb-2">Trasmissione SDI</h4>
                <Row l="Cod. Destinatario" v={d.trasm.codDest} />
                <Row l="Progressivo" v={d.trasm.progressivo} />
                <Row l="PEC" v={d.trasm.pecDest} />
                <Row l="Formato" v={d.trasm.formato} />
              </div>
            )}

            <div className="text-center text-[10px] text-gray-400 pb-4">
              {invoice.source_filename} {'\u2014'} Metodo: {invoice.parse_method} {'\u2014'} Hash: {invoice.xml_hash?.substring(0, 16)}...
            </div>
          </div>
        )}

        {/* TAB: PAGAMENTI */}
        {activeTab === 'pagamenti' && (
          <div className="p-4 space-y-4">
            {/* Rate / Scadenze */}
            <div className="bg-white border rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b bg-gray-50">
                <h4 className="text-xs font-bold text-gray-700">Rate / Scadenze</h4>
                <button onClick={onOpenScadenzario}
                  className="px-2.5 py-1 text-[11px] font-semibold rounded-lg border border-violet-300 text-violet-700 bg-white hover:bg-violet-50">
                  Gestisci pagamenti da Scadenzario
                </button>
              </div>
              {!installments.length ? (
                <div className="px-4 py-6 text-xs text-gray-500 text-center">Nessuna rata disponibile per questa fattura.</div>
              ) : (
                <table className="w-full border-collapse text-[11px]">
                  <thead>
                    <tr className="bg-gray-50 border-b">
                      <th className="text-left px-3 py-2 text-gray-600 font-semibold">Rata</th>
                      <th className="text-left px-2 py-2 text-gray-600 font-semibold">Scadenza</th>
                      <th className="text-right px-2 py-2 text-gray-600 font-semibold">Importo</th>
                      <th className="text-right px-2 py-2 text-gray-600 font-semibold">Pagato</th>
                      <th className="text-left px-2 py-2 text-gray-600 font-semibold">Stato</th>
                    </tr>
                  </thead>
                  <tbody>
                    {installments.map((inst) => (
                      <tr key={inst.id} className="border-b border-gray-50">
                        <td className="px-3 py-2">{inst.installment_total > 1 ? `${inst.installment_no} di ${inst.installment_total}` : 'Unica'}</td>
                        <td className="px-2 py-2">{fmtDate(inst.due_date)}{inst.is_estimated && <span className="ml-1 text-[10px] text-blue-700">stimata</span>}</td>
                        <td className="px-2 py-2 text-right font-semibold">{fmtEur(inst.amount_due)}</td>
                        <td className="px-2 py-2 text-right">{fmtEur(inst.paid_amount)}</td>
                        <td className="px-2 py-2">
                          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                            inst.status === 'paid' ? 'bg-emerald-100 text-emerald-700'
                              : inst.status === 'overdue' ? 'bg-red-100 text-red-700'
                              : inst.status === 'partial' ? 'bg-amber-100 text-amber-700'
                              : 'bg-gray-100 text-gray-700'
                          }`}>
                            {inst.status === 'paid' ? 'Pagata' : inst.status === 'overdue' ? 'Scaduta' : inst.status === 'partial' ? 'Parziale' : 'Da saldare'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Modalita Pagamento */}
            <div className="bg-white border rounded-xl p-4">
              <h4 className="text-xs font-bold text-gray-700 mb-2">Modalit{'\u00E0'} Pagamento</h4>
              <table className="w-full border-collapse text-[11px]">
                <thead><tr className="bg-gray-50 border-b rounded">
                  <th className="text-left px-2 py-1.5 text-gray-600 font-semibold">Modalit{'\u00E0'}</th>
                  <th className="text-left px-2 py-1.5 text-gray-600 font-semibold">IBAN</th>
                  <th className="text-right px-2 py-1.5 text-gray-600 font-semibold">Scadenza</th>
                  <th className="text-right px-2 py-1.5 text-gray-600 font-semibold">Importo</th>
                </tr></thead>
                <tbody>
                  {b?.pagamenti?.length > 0 ? b.pagamenti.map((p: any, i: number) => (
                    <tr key={i} className="border-b border-gray-50">
                      <td className="text-left px-2 py-1.5">{p.modalita ? mpLabel(p.modalita) : ''}{b.condPag ? ` \u2014 ${tpLabel(b.condPag)}` : ''}</td>
                      <td className="text-left px-2 py-1.5">{p.iban || ''}</td>
                      <td className="text-right px-2 py-1.5">{p.scadenza ? fmtDate(p.scadenza) : ''}</td>
                      <td className="text-right px-2 py-1.5 font-bold">{p.importo ? fmtEur(safeFloat(p.importo)) : ''}</td>
                    </tr>
                  )) : (
                    <tr><td colSpan={4} className="text-left px-2 py-1.5 text-gray-400">
                      {invoice.payment_method ? mpLabel(invoice.payment_method) : 'Nessun dettaglio'} {'\u2014'} Scadenza: {invoice.payment_due_date ? fmtDate(invoice.payment_due_date) : '\u2014'} {'\u2014'} {fmtEur(invoice.total_amount)}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB: NOTE */}
        {activeTab === 'note' && (
          <div className="p-4 space-y-4">
            <div className="bg-white border rounded-xl p-4">
              <h4 className="text-xs font-bold text-gray-700 mb-2">Note</h4>
              <textarea
                value={notesText}
                onChange={e => setNotesText(e.target.value)}
                rows={6}
                placeholder="Aggiungi note su questa fattura... (es. motivo dell'acquisto, progetto collegato, dettagli per il commercialista)"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-400 outline-none resize-y bg-gray-50"
              />
              <div className="flex items-center justify-between mt-2">
                <span className="text-[10px] text-gray-400">
                  {notesSaving ? 'Salvataggio...' : notesText !== (invoice.notes || '') ? 'Modifiche non salvate' : 'Salvato'}
                </span>
                <button onClick={handleSaveNotes} disabled={notesSaving || notesText === (invoice.notes || '')}
                  className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-colors">
                  Salva
                </button>
              </div>
            </div>

            {/* Causale (dal XML) */}
            {b?.causali?.length > 0 && (
              <div className="bg-white border rounded-xl p-4">
                <h4 className="text-xs font-bold text-gray-700 mb-2">Causale (dal XML)</h4>
                {b.causali.map((c: string, i: number) => <div key={i} className="text-xs text-gray-700 py-0.5">{c}</div>)}
              </div>
            )}
          </div>
        )}
          </>
        )}
      </div>
      {/* end scrollable */}
      </div>
      {/* end CARD 3 — Tabs + content */}

      {/* Required note dialog for non-conservative fiscal choices (section 3.9) */}
      {requiredNoteDialog && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setRequiredNoteDialog(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-5 pt-5 pb-3">
              <h3 className="text-sm font-bold text-gray-900 mb-1">Motivazione richiesta</h3>
              <p className="text-xs text-gray-500 mb-3">
                Stai scegliendo una classificazione fiscale non conservativa.
                La motivazione verr{'\u00E0'} salvata come nota sulla riga e inclusa nella prima nota.
              </p>
              <textarea
                className="w-full text-xs border border-gray-200 rounded-lg p-3 min-h-[80px] focus:outline-none focus:ring-2 focus:ring-blue-300 resize-y"
                defaultValue={requiredNoteDialog.suggestedNote}
                onChange={e => { requiredNoteTextRef.current = e.target.value; }}
                placeholder="Es: Cuffie wireless utilizzate per videoconferenze operative con cantieri..."
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2 px-5 pb-4">
              <button
                onClick={() => setRequiredNoteDialog(null)}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
              >
                Annulla
              </button>
              <button
                onClick={() => {
                  const noteText = requiredNoteTextRef.current || requiredNoteDialog.suggestedNote;
                  if (!noteText?.trim()) {
                    toast.error('La motivazione è obbligatoria per scelte non conservative');
                    return;
                  }
                  // Save note on affected lines
                  const alert = invoiceNotes[requiredNoteDialog.alertIdx];
                  if (alert) {
                    for (const lineId of alert.affected_lines) {
                      handleSaveLineNote(lineId, noteText.trim());
                    }
                  }
                  // Apply the fiscal decision
                  applyFiscalChoice(requiredNoteDialog.alertIdx, requiredNoteDialog.option);
                  setRequiredNoteDialog(null);
                }}
                className="px-4 py-1.5 text-xs font-bold rounded-lg bg-blue-600 text-white hover:bg-blue-700"
              >
                Conferma e applica
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ============================================================
// INVOICE AI SEARCH — Types + Helpers
// ============================================================
// AI search helpers — shared module (no duplication)
import { askInvoiceAiSearch, type InvoiceAiResult } from '@/lib/invoiceAiSearch';

// ============================================================
// MAIN PAGE
// ============================================================
