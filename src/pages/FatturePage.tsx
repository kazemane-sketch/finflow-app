// src/pages/FatturePage.tsx — v6
// Tab layout redesign: Classification-first UX with Documento/Pagamenti/Note tabs
import React, { startTransition, useState, useCallback, useRef, useEffect, useMemo, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { processInvoiceFile, TIPO, MP, REG, mpLabel, tpLabel } from '@/lib/invoiceParser';
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
import { createMemoryFromClassification, createMemoryFromFiscalChoice, deactivateInvoiceMemoryFacts } from '@/lib/companyMemoryService';
import { extractProvinceSiglaFromAddress, loadCounterpartyHeaderInfo } from '@/lib/counterpartyService';
import { deleteFiscalDecisionsForInvoice, saveFiscalDecision } from '@/lib/fiscalDecisionService';
import ExportDialog from '@/components/ExportDialog';
import SearchableSelect from '@/components/SearchableSelect';
import { ConfidenceBadge, ReasoningBox, FiscalBox, NoteBox } from '@/components/invoice';

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
const STATUS_LABELS: Record<string, string> = { pending: 'Da Pagare', overdue: 'Scaduta', paid: 'Pagata' };
const getStatusLabel = (status: string, direction?: string) => {
  if (status === 'pending') return direction === 'out' ? 'Da Incassare' : 'Da Pagare';
  return STATUS_LABELS[status] || status;
};
const STATUS_COLORS: Record<string, string> = { pending: 'bg-yellow-100 text-yellow-800', overdue: 'bg-red-100 text-red-800', paid: 'bg-green-100 text-green-800' };

// ============================================================
// SAFE NUMBER HELPER — evita NaN quando il campo XML è vuoto
// ============================================================
const safeFloat = (v: any): number => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

// ============================================================
// INLINE XML PARSER — self-contained, no external deps
// ============================================================
function stripNS(x: string) {
  return x.replace(/<(\/?)[\w.-]+:/g, '<$1').replace(/\sxmlns[^=]*="[^"]*"/g, '').replace(/\s[\w.-]+:[\w.-]+=("[^"]*"|'[^']*')/g, '');
}

function parseXmlDetail(xmlStr: string): any {
  const doc = new DOMParser().parseFromString(stripNS(xmlStr), 'text/xml');
  if (doc.querySelector('parsererror')) return null;
  const root = doc.querySelector('FatturaElettronica');
  if (!root) return null;

  const g = (p: Element | null | undefined, s: string) => p?.querySelector(s)?.textContent?.trim() || '';
  const gA = (p: Element | null | undefined, s: string) => Array.from(p?.querySelectorAll(s) || []);

  const hdr = root.querySelector('FatturaElettronicaHeader');
  const tr = hdr?.querySelector('DatiTrasmissione');
  const ced = hdr?.querySelector('CedentePrestatore');
  const ces = hdr?.querySelector('CessionarioCommittente');
  const fAddr = (el: Element | null | undefined) => {
    if (!el) return '';
    return [[g(el, 'Indirizzo'), g(el, 'NumeroCivico')].filter(Boolean).join(' '),
      [g(el, 'CAP'), g(el, 'Comune'), g(el, 'Provincia') ? `(${g(el, 'Provincia')})` : ''].filter(Boolean).join(' '),
      g(el, 'Nazione') !== 'IT' ? g(el, 'Nazione') : ''].filter(Boolean).join(', ');
  };

  const bodies = gA(root, 'FatturaElettronicaBody').map(body => {
    const dg = body.querySelector('DatiGenerali DatiGeneraliDocumento');
    const dgAll = body.querySelector('DatiGenerali');
    const bs = body.querySelector('DatiBeniServizi');
    const pg = body.querySelector('DatiPagamento');
    return {
      tipo: g(dg, 'TipoDocumento'), divisa: g(dg, 'Divisa'), data: g(dg, 'Data'), numero: g(dg, 'Numero'),
      totale: g(dg, 'ImportoTotaleDocumento'), arrotondamento: g(dg, 'Arrotondamento'),
      sconti: gA(dg, 'ScontoMaggiorazione').map(s => ({ tipo: g(s, 'Tipo'), percentuale: g(s, 'Percentuale'), importo: g(s, 'Importo') })),
      causali: gA(dg, 'Causale').map(c => c.textContent?.trim() || ''),
      bollo: { virtuale: g(dg, 'DatiBollo BolloVirtuale'), importo: g(dg, 'DatiBollo ImportoBollo') },
      ritenuta: { tipo: g(dg, 'DatiRitenuta TipoRitenuta'), importo: g(dg, 'DatiRitenuta ImportoRitenuta'), aliquota: g(dg, 'DatiRitenuta AliquotaRitenuta'), causale: g(dg, 'DatiRitenuta CausalePagamento') },
      cassa: { tipo: g(dg, 'DatiCassaPrevidenziale TipoCassa'), al: g(dg, 'DatiCassaPrevidenziale AlCassa'), importo: g(dg, 'DatiCassaPrevidenziale ImportoContributoCassa') },
      contratti: gA(dgAll, 'DatiContratto').map(c => ({ id: g(c, 'IdDocumento'), data: g(c, 'Data'), cig: g(c, 'CodiceCIG'), cup: g(c, 'CodiceCUP') })),
      ordini: gA(dgAll, 'DatiOrdineAcquisto').map(o => ({ id: g(o, 'IdDocumento'), data: g(o, 'Data'), cig: g(o, 'CodiceCIG'), cup: g(o, 'CodiceCUP') })),
      convenzioni: gA(dgAll, 'DatiConvenzione').map(c => ({ id: g(c, 'IdDocumento'), data: g(c, 'Data') })),
      ddt: gA(dgAll, 'DatiDDT').map(d => ({ numero: g(d, 'NumeroDDT'), data: g(d, 'DataDDT') })),
      condPag: g(pg, 'CondizioniPagamento'),
      pagamenti: gA(pg, 'DettaglioPagamento').map(dp => ({
        modalita: g(dp, 'ModalitaPagamento'), scadenza: g(dp, 'DataScadenzaPagamento'),
        importo: g(dp, 'ImportoPagamento'), iban: g(dp, 'IBAN'),
        istituto: g(dp, 'IstitutoFinanziario'), beneficiario: g(dp, 'Beneficiario'),
      })),
      linee: gA(bs, 'DettaglioLinee').map(l => ({
        numero: g(l, 'NumeroLinea'),
        codiceArticolo: gA(l, 'CodiceArticolo').map(c => `${g(c, 'CodiceTipo')}: ${g(c, 'CodiceValore')}`).join(', '),
        descrizione: g(l, 'Descrizione'), quantita: g(l, 'Quantita'), unitaMisura: g(l, 'UnitaMisura'),
        prezzoUnitario: g(l, 'PrezzoUnitario'), prezzoTotale: g(l, 'PrezzoTotale'),
        aliquotaIVA: g(l, 'AliquotaIVA'), natura: g(l, 'Natura'),
      })),
      riepilogo: gA(bs, 'DatiRiepilogo').map(r => ({
        aliquota: g(r, 'AliquotaIVA'), natura: g(r, 'Natura'),
        imponibile: g(r, 'ImponibileImporto'), imposta: g(r, 'Imposta'),
        esigibilita: g(r, 'EsigibilitaIVA'), rifNorm: g(r, 'RiferimentoNormativo'),
      })),
      allegati: gA(body, 'Allegati').map(a => {
        const b64 = a.querySelector('Attachment')?.textContent?.trim() || '';
        return { nome: g(a, 'NomeAttachment'), formato: g(a, 'FormatoAttachment'), descrizione: g(a, 'DescrizioneAttachment'), sizeKB: b64 ? Math.round(b64.length * 3 / 4 / 1024) : 0, hasData: b64.length > 0, b64 };
      }),
    };
  });

  return {
    ver: root.getAttribute('versione') || '',
    trasm: { idPaese: g(tr, 'IdTrasmittente IdPaese'), idCodice: g(tr, 'IdTrasmittente IdCodice'), progressivo: g(tr, 'ProgressivoInvio'), formato: g(tr, 'FormatoTrasmissione'), codDest: g(tr, 'CodiceDestinatario'), pecDest: g(tr, 'PECDestinatario') },
    ced: {
      denom: g(ced, 'DatiAnagrafici Anagrafica Denominazione') || [g(ced, 'DatiAnagrafici Anagrafica Nome'), g(ced, 'DatiAnagrafici Anagrafica Cognome')].filter(Boolean).join(' '),
      piva: [g(ced, 'DatiAnagrafici IdFiscaleIVA IdPaese'), g(ced, 'DatiAnagrafici IdFiscaleIVA IdCodice')].filter(Boolean).join(''),
      cf: g(ced, 'DatiAnagrafici CodiceFiscale'), regime: g(ced, 'DatiAnagrafici RegimeFiscale'),
      sede: fAddr(ced?.querySelector('Sede')),
      tel: g(ced, 'Contatti Telefono'), email: g(ced, 'Contatti Email'),
      reaUfficio: g(ced, 'IscrizioneREA Ufficio'), reaNumero: g(ced, 'IscrizioneREA NumeroREA'),
      capitale: g(ced, 'IscrizioneREA CapitaleSociale'), socioUnico: g(ced, 'IscrizioneREA SocioUnico'),
      liquidazione: g(ced, 'IscrizioneREA StatoLiquidazione'),
    },
    ces: {
      denom: g(ces, 'DatiAnagrafici Anagrafica Denominazione') || [g(ces, 'DatiAnagrafici Anagrafica Nome'), g(ces, 'DatiAnagrafici Anagrafica Cognome')].filter(Boolean).join(' '),
      piva: [g(ces, 'DatiAnagrafici IdFiscaleIVA IdPaese'), g(ces, 'DatiAnagrafici IdFiscaleIVA IdCodice')].filter(Boolean).join(''),
      cf: g(ces, 'DatiAnagrafici CodiceFiscale'), sede: fAddr(ces?.querySelector('Sede')),
    },
    bodies,
  };
}

function extractPrimaryContractRef(rawXml?: string | null): string | null {
  if (!rawXml) return null;
  try {
    const parsed = parseXmlDetail(rawXml);
    const body = parsed?.bodies?.[0];
    return body?.contratti?.[0]?.id || null;
  } catch {
    return null;
  }
}

// ============================================================
// UI HELPERS
// ============================================================
function Sec({ title, children, open: dO = true }: { title: string; children: React.ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(dO);
  return (
    <div className="mb-3 bg-white border rounded-lg overflow-hidden">
      <div onClick={() => setOpen(!open)} className={`flex items-center cursor-pointer px-3 py-2.5 ${open ? 'bg-sky-50 border-b' : 'bg-gray-50'}`}>
        <span className="text-xs font-bold text-sky-700 flex-1">{title}</span>
        <span className={`text-gray-400 text-[10px] transition-transform ${open ? 'rotate-180' : ''}`}>▼</span>
      </div>
      {open && <div className="px-3 py-2.5">{children}</div>}
    </div>
  );
}
function Row({ l, v, accent, bold }: { l: string; v?: string | null; accent?: boolean; bold?: boolean }) {
  if (!v) return null;
  return (<div className="flex justify-between items-baseline py-0.5 border-b border-gray-100">
    <span className="text-gray-500 text-xs min-w-[120px]">{l}</span>
    <span className={`text-xs text-right max-w-[64%] break-words ${accent ? 'text-sky-700 font-bold' : bold ? 'font-bold' : ''}`}>{v}</span>
  </div>);
}

// ============================================================
// CONFIRM DELETE MODAL
// ============================================================
function ConfirmDeleteModal({ open, count, onConfirm, onCancel }: { open: boolean; count: number; onConfirm: (pw: string) => void; onCancel: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setPassword(''); setError(''); setTimeout(() => inputRef.current?.focus(), 100); } }, [open]);
  if (!open) return null;
  const handleConfirm = async () => {
    if (!password.trim()) { setError('Inserisci la password'); return; }
    setLoading(true); setError('');
    const ok = await verifyPassword(password);
    setLoading(false);
    if (ok) onConfirm(password); else setError('Password errata');
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onCancel}>
      <div className="bg-white rounded-xl shadow-2xl p-6 max-w-md w-full mx-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center"><span className="text-red-600 text-lg">🗑</span></div>
          <div><h3 className="text-lg font-bold text-gray-900">Conferma Eliminazione</h3><p className="text-sm text-gray-500">{count === 1 ? 'Stai per eliminare 1 fattura' : `Stai per eliminare ${count} fatture`}</p></div>
        </div>
        <p className="text-sm text-gray-600 mb-4">Questa azione è <span className="font-semibold text-red-600">irreversibile</span>. Inserisci la tua password per confermare.</p>
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
          <input ref={inputRef} type="password" value={password} onChange={e => { setPassword(e.target.value); setError(''); }} onKeyDown={e => e.key === 'Enter' && handleConfirm()}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 outline-none" placeholder="Inserisci la tua password" />
          {error && <p className="text-sm text-red-600 mt-1">{error}</p>}
        </div>
        <div className="flex justify-end gap-3">
          <button onClick={onCancel} className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">Annulla</button>
          <button onClick={handleConfirm} disabled={loading} className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50">{loading ? 'Verifica...' : `Elimina ${count} fattur${count === 1 ? 'a' : 'e'}`}</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// EDIT FORM
// ============================================================
function EditForm({ invoice, onSave, onCancel }: { invoice: DBInvoice; onSave: (u: InvoiceUpdate) => Promise<void>; onCancel: () => void }) {
  const [form, setForm] = useState<InvoiceUpdate>({ number: invoice.number, date: invoice.date, total_amount: invoice.total_amount, payment_due_date: invoice.payment_due_date || '', payment_method: invoice.payment_method, notes: invoice.notes });
  const [saving, setSaving] = useState(false);
  const handleSave = async () => { setSaving(true); try { await onSave(form); } finally { setSaving(false); } };
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
      <h4 className="text-sm font-bold text-blue-800 mb-3">✏️ Modifica Fattura</h4>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="block text-xs font-medium text-gray-600 mb-1">Numero</label><input value={form.number || ''} onChange={e => setForm({ ...form, number: e.target.value })} className="w-full px-2 py-1.5 text-sm border rounded focus:ring-1 focus:ring-blue-400 outline-none" /></div>
        <div><label className="block text-xs font-medium text-gray-600 mb-1">Data</label><input type="date" value={form.date || ''} onChange={e => setForm({ ...form, date: e.target.value })} className="w-full px-2 py-1.5 text-sm border rounded focus:ring-1 focus:ring-blue-400 outline-none" /></div>
        <div><label className="block text-xs font-medium text-gray-600 mb-1">Totale (€)</label><input type="number" step="0.01" value={form.total_amount ?? ''} onChange={e => setForm({ ...form, total_amount: parseFloat(e.target.value) || 0 })} className="w-full px-2 py-1.5 text-sm border rounded focus:ring-1 focus:ring-blue-400 outline-none" /></div>
        <div><label className="block text-xs font-medium text-gray-600 mb-1">Stato</label><div className="w-full px-2 py-1.5 text-sm border rounded bg-gray-100 text-gray-600">{getStatusLabel(invoice.payment_status, invoice.direction)}</div></div>
        <div><label className="block text-xs font-medium text-gray-600 mb-1">Scadenza</label><input type="date" value={form.payment_due_date || ''} onChange={e => setForm({ ...form, payment_due_date: e.target.value || null })} className="w-full px-2 py-1.5 text-sm border rounded focus:ring-1 focus:ring-blue-400 outline-none" /></div>
        <div><label className="block text-xs font-medium text-gray-600 mb-1">Modalità Pag.</label><select value={form.payment_method || ''} onChange={e => setForm({ ...form, payment_method: e.target.value })} className="w-full px-2 py-1.5 text-sm border rounded focus:ring-1 focus:ring-blue-400 outline-none"><option value="">—</option>{Object.entries(MP).map(([k, v]) => <option key={k} value={k}>{k} — {v}</option>)}</select></div>
      </div>
      <div className="mt-3"><label className="block text-xs font-medium text-gray-600 mb-1">Note</label><textarea value={form.notes || ''} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} className="w-full px-2 py-1.5 text-sm border rounded focus:ring-1 focus:ring-blue-400 outline-none resize-none" /></div>
      <div className="flex justify-end gap-2 mt-3">
        <button onClick={onCancel} className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded hover:bg-gray-200">Annulla</button>
        <button onClick={handleSave} disabled={saving} className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-50">{saving ? 'Salvataggio...' : '💾 Salva Modifiche'}</button>
      </div>
    </div>
  );
}

// ============================================================
// IMPORT PROGRESS
// ============================================================
interface ImportLog { fn: string; status: 'ok' | 'duplicate' | 'error_parse' | 'error_save'; message?: string | null; }
function ImportProgress({ phase, current, total, logs }: { phase: 'reading' | 'saving' | 'done'; current: number; total: number; logs: ImportLog[] }) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  const okC = logs.filter(l => l.status === 'ok').length, dupC = logs.filter(l => l.status === 'duplicate').length, errC = logs.filter(l => l.status.startsWith('error')).length;
  return (
    <div className="bg-white border rounded-lg p-4 mb-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-gray-700">{phase === 'reading' ? '📂 Lettura file...' : phase === 'saving' ? '💾 Salvataggio...' : '✅ Importazione completata'}</span>
        <span className="text-xs text-gray-500">{current}/{total} — {pct}%</span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-2 mb-3"><div className={`h-2 rounded-full transition-all ${phase === 'done' ? 'bg-green-500' : 'bg-sky-500'}`} style={{ width: `${pct}%` }} /></div>
      {(okC > 0 || dupC > 0 || errC > 0) && <div className="flex gap-2 text-xs"><span className="text-green-700">✓ {okC} salvate</span>{dupC > 0 && <span className="text-yellow-700">⚠ {dupC} duplicate</span>}{errC > 0 && <span className="text-red-700">✕ {errC} errori</span>}</div>}
      {errC > 0 && <div className="mt-2 max-h-24 overflow-y-auto">{logs.filter(l => l.status.startsWith('error')).map((l, i) => <div key={i} className="text-[10px] text-red-600 truncate">✕ {l.fn}: {l.message}</div>)}</div>}
    </div>
  );
}

// ============================================================
// REVIEW BADGE — shows AI confidence-based review indicators on lines
// ============================================================
function ReviewBadge({ confidence, hasNote, needsReview }: {
  confidence?: number; hasNote?: boolean; needsReview?: boolean;
}) {
  const conf = confidence;
  if (!needsReview && (conf == null || conf > 65)) return null;

  if (conf != null && conf < 50) {
    return <span className="ml-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-300 whitespace-nowrap">{'\u26A0\uFE0F'} Da revisionare</span>;
  }
  if (conf != null && conf <= 65 && hasNote) {
    return <span className="ml-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 border border-orange-300 whitespace-nowrap">{'\u26A1'} Verifica fiscale</span>;
  }
  if (conf != null && conf <= 65) {
    return <span className="ml-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-700 border border-yellow-300 whitespace-nowrap">{'\uD83D\uDCA1'} Suggerimento AI</span>;
  }
  if (needsReview) {
    return <span className="ml-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-700 border border-yellow-300 whitespace-nowrap">{'\uD83D\uDCA1'} Suggerimento AI</span>;
  }
  return null;
}

/* ─── Pipeline Debug Panel ─────────────────────── */

function PipelineStepDetailPanel({ step }: { step: PipelineStepDebug }) {
  const stepLabels: Record<string, string> = {
    deterministic: '\uD83D\uDD0D Step 1: Regole + Storico',
    understand: '\uD83E\uDDE0 Step 2: Comprensione',
    classify: '\uD83D\uDCCB Step 3: Classificazione',
    cdc: '\uD83C\uDFE2 Step 4: Centri di Costo',
    reviewer: '\u2696\uFE0F Step 5: Revisore Fiscale',
  };

  return (
    <details className="border border-slate-100 rounded-lg">
      <summary className="px-3 py-2 bg-slate-50 cursor-pointer text-xs font-semibold text-slate-600 hover:bg-slate-100 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>{stepLabels[step.step] || step.step}</span>
        {step.model_used && <span className="text-[10px] font-normal text-slate-400">({step.model_used})</span>}
        {step.kb_rules_count !== undefined && <span className="text-[10px] font-normal text-slate-400">KB: {step.kb_rules_count} regole</span>}
        {step.agent_rules_count !== undefined && <span className="text-[10px] font-normal text-slate-400">Rules: {step.agent_rules_count}</span>}
        {step.accounts_shown !== undefined && <span className="text-[10px] font-normal text-slate-400">Conti: {step.accounts_shown}</span>}
        {step.company_ateco && <span className="text-[10px] font-normal text-emerald-600">ATECO: {step.company_ateco}</span>}
      </summary>
      <div className="p-3 space-y-3 text-xs">

        {/* Config status badges */}
        <div className="flex flex-wrap gap-2">
          {step.agent_config_loaded !== undefined && (
            <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${step.agent_config_loaded ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
              {step.agent_config_loaded ? '\u2713 Agent Config' : '\u2717 Agent Config MANCANTE'}
            </span>
          )}
          {step.agent_rules_count !== undefined && (
            <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-700 text-[10px] font-semibold">
              {step.agent_rules_count} Agent Rules
            </span>
          )}
          {step.kb_rules_count !== undefined && (
            <span className="px-2 py-0.5 rounded bg-purple-100 text-purple-700 text-[10px] font-semibold">
              {step.kb_rules_count} KB Rules
            </span>
          )}
        </div>

        {/* KB Rules titles */}
        {step.kb_rules_titles && step.kb_rules_titles.length > 0 && (
          <div>
            <div className="font-semibold text-slate-500 mb-1">Regole KB caricate:</div>
            <div className="flex flex-wrap gap-1">
              {step.kb_rules_titles.map((t, i) => (
                <span key={i} className="px-1.5 py-0.5 rounded bg-purple-50 text-purple-600 text-[10px]">{t}</span>
              ))}
            </div>
          </div>
        )}

        {/* Understandings (for classify step) */}
        {step.understandings && step.understandings.length > 0 && (
          <div>
            <div className="font-semibold text-slate-500 mb-1">Comprensione Stadio A:</div>
            {step.understandings.map((u, i) => (
              <div key={i} className="ml-2 mb-1">
                <span className="text-slate-400">[{u.line_id.slice(0, 8)}]</span>{' '}
                <span className="font-semibold">{u.operation_type}</span>{' '}
                {'\u2192'} sezioni: <span className="text-blue-600">{u.account_sections.join(', ')}</span>
                {u.is_NOT.length > 0 && (
                  <span className="text-red-500 ml-1">NON: {u.is_NOT.join(', ')}</span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Accounts by section */}
        {step.accounts_by_section && (
          <div>
            <div className="font-semibold text-slate-500 mb-1">Conti per sezione:</div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(step.accounts_by_section).map(([section, count]) => (
                <span key={section} className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px]">
                  {section}: {count as number}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Extra data */}
        {step.extra && Object.keys(step.extra).length > 0 && (
          <div>
            <div className="font-semibold text-slate-500 mb-1">Dati aggiuntivi:</div>
            <pre className="text-[10px] bg-slate-50 p-2 rounded overflow-x-auto max-h-32 overflow-y-auto">
              {JSON.stringify(step.extra, null, 2)}
            </pre>
          </div>
        )}

        {/* Prompt sent (collapsible) */}
        {step.prompt_sent && (
          <details className="border border-slate-100 rounded">
            <summary className="px-2 py-1 cursor-pointer text-[10px] font-semibold text-slate-500 hover:bg-slate-50 flex items-center justify-between">
              <span>{'\uD83D\uDCCB'} Prompt inviata ({step.prompt_sent.length.toLocaleString()} chars)</span>
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  navigator.clipboard.writeText(step.prompt_sent!);
                  toast.success('Prompt copiata');
                }}
                className="text-blue-500 hover:text-blue-700 text-[10px]"
              >
                Copia
              </button>
            </summary>
            <pre className="p-2 text-[10px] font-mono bg-slate-900 text-slate-300 overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap">
              {step.prompt_sent}
            </pre>
          </details>
        )}

        {/* Raw AI response (collapsible) */}
        {step.raw_response && (
          <details className="border border-slate-100 rounded">
            <summary className="px-2 py-1 cursor-pointer text-[10px] font-semibold text-slate-500 hover:bg-slate-50 flex items-center justify-between">
              <span>{'\uD83E\uDD16'} Risposta AI ({step.raw_response.length.toLocaleString()} chars)</span>
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  navigator.clipboard.writeText(step.raw_response!);
                  toast.success('Risposta copiata');
                }}
                className="text-blue-500 hover:text-blue-700 text-[10px]"
              >
                Copia
              </button>
            </summary>
            <pre className="p-2 text-[10px] font-mono bg-slate-900 text-green-300 overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap">
              {step.raw_response}
            </pre>
          </details>
        )}
      </div>
    </details>
  );
}

function SingleInvoiceAIProgressCard({ job, onStop }: { job: AIJob; onStop: () => void }) {
  const pct = job.total > 0 ? Math.round((job.current / job.total) * 100) : 0;
  const logs = job.logs.slice(-4);

  return (
    <div className="border border-violet-200 bg-violet-50 rounded-xl p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm animate-spin">{'\u21BB'}</span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-violet-800 truncate">{job.label}</div>
          <div className="text-[11px] text-violet-700 truncate">
            {job.stage || 'Classificazione AI in corso'}
          </div>
        </div>
        <button
          onClick={onStop}
          className="px-2 py-1 text-[10px] font-semibold rounded-md border border-violet-300 text-violet-700 hover:bg-violet-100"
        >
          Stop
        </button>
      </div>

      {(job.message || job.total > 0) && (
        <div className="space-y-1">
          {job.message && (
            <p className="text-[11px] text-violet-700">{job.message}</p>
          )}
          {job.total > 0 && (
            <>
              <div className="flex items-center justify-between text-[10px] text-violet-700">
                <span>{job.current}/{job.total}</span>
                <span>{pct}%</span>
              </div>
              <div className="h-2 rounded-full bg-violet-200 overflow-hidden">
                <div
                  className="h-full rounded-full bg-violet-500 transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </>
          )}
        </div>
      )}

      {logs.length > 0 && (
        <div className="bg-white/80 border border-violet-100 rounded-lg px-2.5 py-2">
          <div className="text-[10px] font-semibold text-violet-700 uppercase tracking-wide mb-1">Log attività</div>
          <div className="space-y-1">
            {logs.map(log => (
              <div key={log.at} className="text-[11px] text-slate-600 leading-snug">
                {log.text}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// SIDEBAR CARD
// ============================================================
function InvoiceCard({ inv, selected, checked, selectMode, onSelect, onCheck, onPrefetch, isMatched, suggestionScore, meta, rowRef }: { inv: DBInvoice; selected: boolean; checked: boolean; selectMode: boolean; onSelect: () => void; onCheck: () => void; onPrefetch?: () => void; isMatched?: boolean; suggestionScore?: number; meta?: InvoiceClassificationMeta; rowRef?: (node: HTMLDivElement | null) => void }) {
  const nc = inv.doc_type === 'TD04' || inv.doc_type === 'TD05';
  const cp = (inv.counterparty || {}) as any;
  const displayName = cp?.denom || inv.source_filename || 'Sconosciuto';
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Classification started = at least one field present on at least one line
  const hasAnyField = meta && (
    meta.lines_with_category > 0 || meta.lines_with_account > 0 ||
    meta.lines_with_cdc > 0 || meta.lines_with_article > 0
  );
  const needsClassification = !hasAnyField && inv.classification_status !== 'ai_suggested';
  const schedulePrefetch = () => {
    if (!onPrefetch) return;
    if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current);
    prefetchTimerRef.current = setTimeout(() => onPrefetch(), 120);
  };
  const cancelPrefetch = () => {
    if (!prefetchTimerRef.current) return;
    clearTimeout(prefetchTimerRef.current);
    prefetchTimerRef.current = null;
  };

  useEffect(() => cancelPrefetch, []);

  return (
    <div
      ref={rowRef}
      data-invoice-id={inv.id}
      tabIndex={0}
      onMouseEnter={schedulePrefetch}
      onMouseLeave={cancelPrefetch}
      onFocus={schedulePrefetch}
      onBlur={cancelPrefetch}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`flex items-start gap-2 px-3 py-2.5 cursor-pointer border-b border-gray-100 transition-all ${checked ? 'bg-blue-50 border-l-4 border-l-blue-500' : selected ? 'bg-sky-50 border-l-4 border-l-sky-500' : 'border-l-4 border-l-transparent hover:bg-gray-50'}`}
    >
      {selectMode && <input type="checkbox" checked={checked} onChange={onCheck} className="mt-1 accent-blue-600 cursor-pointer flex-shrink-0" onClick={e => e.stopPropagation()} />}
      <div className="flex-1 min-w-0" onClick={onSelect}>
        <div className="flex justify-between items-center">
          <span className="text-xs font-semibold text-gray-800 truncate max-w-[55%]">{displayName}</span>
          <span className={`text-xs font-bold ${inv.direction === 'in' ? 'text-red-600' : 'text-emerald-700'}`}>{fmtEur(inv.total_amount)}</span>
        </div>
        <div className="flex justify-between items-center mt-0.5">
          <span className="text-[10px] text-gray-500">n.{inv.number} — {fmtDate(inv.date)}</span>
          <span className="flex items-center gap-1">
            {isMatched && <ReconciledIcon size={12} />}
            {!isMatched && suggestionScore != null && <ReconciliationDot score={suggestionScore} invoiceId={inv.id} />}
            {(inv as any).has_fiscal_alerts && <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700" title="Alert fiscali da verificare">{'\u26A0\uFE0F'}</span>}
            {meta && meta.review_count > 0 && <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-rose-100 text-rose-700" title={`${meta.review_count} righe da revisionare`}>{'\uD83D\uDD0D'} {meta.review_count}</span>}
            {nc && <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-red-100 text-red-700">NC</span>}
            <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${STATUS_COLORS[inv.payment_status] || 'bg-gray-100 text-gray-600'}`}>{getStatusLabel(inv.payment_status, inv.direction)}</span>
          </span>
        </div>
        {/* Classification chip badges */}
        <div className="flex items-center gap-1 mt-1 flex-wrap">
          {hasAnyField && meta ? (
            <>
              {/* Category: no badge when 0, full when all, warning when partial */}
              {meta.lines_with_category > 0 && (meta.has_category
                ? <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">Cat</span>
                : <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300">!Cat</span>)}
              {/* CdC */}
              {meta.lines_with_cdc > 0 && (meta.has_cost_center
                ? <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">CdC</span>
                : <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300">!CdC</span>)}
              {/* Account */}
              {meta.lines_with_account > 0 && (meta.has_account
                ? <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">Conto</span>
                : <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300">!Conto</span>)}
              {/* Article: uses lines_with_complete_article for phase-aware check */}
              {meta.lines_with_article > 0 && (meta.has_article
                ? <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">Art</span>
                : <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300">!Art</span>)}
            </>
          ) : inv.classification_status === 'ai_suggested' ? (
            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 flex items-center gap-0.5">&#9889; Da confermare</span>
          ) : needsClassification ? (
            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 flex items-center gap-0.5">&#9889; Da classificare</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// ARTICLE ASSIGNMENT — inline dropdown on invoice lines
// ============================================================
interface LineArticleInfo {
  article_id: string; code: string; name: string;
  assigned_by: string; verified: boolean; location: string | null;
  phase_id: string | null; phase_code: string | null; phase_name: string | null;
}

function ArticleDropdown({ articles, current, suggestion, onAssign, onRemove, onDismissSuggestion }: {
  articles: ArticleWithPhases[]; current: LineArticleInfo | null;
  suggestion: MatchResult | null;
  onAssign: (articleId: string, suggestedPhaseId?: string | null) => void; onRemove: () => void;
  onDismissSuggestion?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, dropUp: false });

  // Calculate dropdown position from button rect when opening
  useEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const dropH = 240; // approximate max dropdown height
    const spaceBelow = window.innerHeight - rect.bottom;
    const dropUp = spaceBelow < dropH && rect.top > dropH;
    setPos({
      top: dropUp ? rect.top - 4 : rect.bottom + 4,
      left: Math.max(8, rect.right - 256), // 256px = w-64
      dropUp,
    });
  }, [open]);

  // Close on click outside (check both button and portal dropdown)
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || dropRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const filtered = articles.filter(a => {
    if (!search) return true;
    const q = search.toLowerCase();
    return a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q);
  });

  const isSuggested = suggestion && suggestion.confidence >= 70 && !current;

  const dropdown = open ? createPortal(
    <div ref={dropRef}
      className="w-64 bg-white border border-gray-200 rounded-lg shadow-xl overflow-hidden"
      style={{
        position: 'fixed',
        zIndex: 9999,
        left: pos.left,
        ...(pos.dropUp
          ? { top: pos.top, transform: 'translateY(-100%)' }
          : { top: pos.top }),
      }}>
      <div className="p-1.5 border-b">
        <input autoFocus value={search} onChange={e => setSearch(e.target.value)}
          className="w-full px-2 py-1 text-[11px] border border-gray-200 rounded focus:ring-1 focus:ring-sky-400 outline-none" placeholder="Cerca articolo..." />
      </div>
      <div className="max-h-48 overflow-y-auto">
        {current && (
          <button onClick={() => { onRemove(); setOpen(false); setSearch(''); }}
            className="w-full text-left px-2.5 py-1.5 text-[11px] text-red-600 hover:bg-red-50 border-b border-gray-100">
            ✕ Rimuovi assegnazione
          </button>
        )}
        {isSuggested && !search && (
          <>
            <button onClick={() => { onAssign(suggestion!.article.id, suggestion!.phase_id); setOpen(false); setSearch(''); }}
              className="w-full text-left px-2.5 py-1.5 text-[11px] bg-orange-50 text-orange-800 hover:bg-orange-100 border-b border-gray-100 flex items-center gap-1.5">
              <span>⚡</span>
              <span className="font-semibold">{suggestion!.article.code}</span>
              <span className="text-gray-500">— {suggestion!.article.name}</span>
              {suggestion!.phase_id && (() => {
                const ph = (suggestion!.article as ArticleWithPhases)?.phases?.find(p => p.id === suggestion!.phase_id);
                return ph ? <span className="text-[9px] text-purple-600 font-medium">{ph.code}</span> : null;
              })()}
              <span className="ml-auto text-[9px] text-orange-600">{Math.round(suggestion!.confidence)}%</span>
            </button>
            {onDismissSuggestion && (
              <button onClick={() => { onDismissSuggestion(); setOpen(false); setSearch(''); }}
                className="w-full text-left px-2.5 py-1.5 text-[11px] text-red-600 hover:bg-red-50 border-b border-gray-100">
                ✕ Ignora suggerimento
              </button>
            )}
          </>
        )}
        {filtered.map(a => (
          <button key={a.id}
            onClick={() => { onAssign(a.id); setOpen(false); setSearch(''); }}
            className={`w-full text-left px-2.5 py-1.5 text-[11px] hover:bg-sky-50 border-b border-gray-50 flex items-center gap-1.5 ${current?.article_id === a.id ? 'bg-sky-50 font-semibold' : ''}`}>
            <span className="font-mono text-sky-700 font-semibold text-[10px] min-w-[52px]">{a.code}</span>
            <span className="text-gray-700 truncate">{a.name}</span>
          </button>
        ))}
        {filtered.length === 0 && <div className="px-2.5 py-2 text-[11px] text-gray-400 text-center">Nessun articolo trovato</div>}
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <span className="inline-block print:hidden">
      {current ? (
        <button ref={btnRef} onClick={() => setOpen(!open)}
          className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-green-100 text-green-800 border border-green-300 hover:bg-green-200 transition-colors cursor-pointer whitespace-nowrap">
          {current.code}
        </button>
      ) : isSuggested ? (
        <span className="inline-flex items-center gap-0">
          <button ref={btnRef} onClick={() => setOpen(!open)}
            className="px-1.5 py-0.5 text-[9px] font-medium rounded-l bg-orange-50 text-orange-700 border border-orange-300 border-r-0 hover:bg-orange-100 transition-colors cursor-pointer whitespace-nowrap flex items-center gap-0.5">
            <span>⚡</span><span>{suggestion!.article.code}</span>
          </button>
          {onDismissSuggestion && (
            <button onClick={(e) => { e.stopPropagation(); onDismissSuggestion(); }}
              title="Ignora suggerimento"
              className="px-1 py-0.5 text-[9px] rounded-r bg-orange-50 text-orange-400 border border-orange-300 border-l-0 hover:bg-red-50 hover:text-red-600 transition-colors cursor-pointer">
              ✕
            </button>
          )}
        </span>
      ) : (
        <button ref={btnRef} onClick={() => setOpen(!open)}
          className="px-1.5 py-0.5 text-[9px] text-gray-400 rounded border border-dashed border-gray-300 hover:border-gray-400 hover:text-gray-600 transition-colors cursor-pointer whitespace-nowrap">
          + Art.
        </button>
      )}
      {dropdown}
    </span>
  );
}

// ============================================================
// PHASE DROPDOWN — cascading dropdown for article phases
// ============================================================
function PhaseDropdown({ phases, currentPhaseId, onSelect }: {
  phases: ArticlePhase[];
  currentPhaseId: string | null;
  onSelect: (phaseId: string | null) => void;
}) {
  const sorted = useMemo(() => [...phases].sort((a, b) => a.sort_order - b.sort_order), [phases]);
  const current = sorted.find(p => p.id === currentPhaseId);

  return (
    <select
      value={currentPhaseId || ''}
      onChange={e => onSelect(e.target.value || null)}
      className={`px-1.5 py-0.5 text-[9px] border rounded-md outline-none cursor-pointer max-w-[140px] ${
        currentPhaseId
          ? 'bg-teal-50 border-teal-300 text-teal-800 font-semibold'
          : 'bg-orange-50 border-orange-300 text-orange-700 animate-pulse'
      }`}
      title={current ? `${current.code} — ${current.name}` : 'Seleziona fase'}
    >
      <option value="">{'\u2014'} Fase {'\u2014'}</option>
      {sorted.map(p => (
        <option key={p.id} value={p.id}>
          {p.is_counting_point ? '\u25CF ' : ''}{p.code} {'\u2014'} {p.name}
        </option>
      ))}
    </select>
  );
}

// ============================================================
// FULL INVOICE DETAIL — matches artifact output
// ============================================================
type DetailTab = 'classificazione' | 'documento' | 'pagamenti' | 'note';
const DETAIL_TABS: { key: DetailTab; label: string; icon: string }[] = [
  { key: 'classificazione', label: 'Classificazione', icon: '\uD83C\uDFF7\uFE0F' },
  { key: 'documento', label: 'Documento', icon: '\uD83D\uDCC4' },
  { key: 'pagamenti', label: 'Pagamenti', icon: '\uD83D\uDCB3' },
  { key: 'note', label: 'Note', icon: '\uD83D\uDCDD' },
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

/* ─── Aggregate fiscal notes from Sonnet + Haiku fiscal_flags ─── */
function buildAggregatedNotes(
  sonnetNotes: FiscalAlert[],
  fiscalFlags: Record<string, any>,
): FiscalAlert[] {
  const alerts: FiscalAlert[] = [...sonnetNotes];

  // Group Haiku fiscal_flags.note by similar text
  const noteGroups = new Map<string, { note: string; lineIds: string[]; deducPct: number; ivaPct: number; ff: any }>();
  for (const [lineId, ff] of Object.entries(fiscalFlags)) {
    if (!ff?.note || typeof ff.note !== 'string') continue;
    // Only notes suggesting user action
    if (!/verificar|controllare|richiedere|attenzione|possibil/i.test(ff.note)) continue;
    const key = ff.note.slice(0, 80).toLowerCase();
    if (noteGroups.has(key)) {
      noteGroups.get(key)!.lineIds.push(lineId);
    } else {
      noteGroups.set(key, {
        note: ff.note,
        lineIds: [lineId],
        deducPct: ff.deducibilita_pct ?? 100,
        ivaPct: ff.iva_detraibilita_pct ?? 100,
        ff,
      });
    }
  }

  for (const [, group] of noteGroups) {
    let type: FiscalAlert['type'] = 'general';
    if (/deducibil|auto|mezzo|trasporto|veicol/i.test(group.note)) type = 'deducibilita';
    if (/ritenuta/i.test(group.note)) type = 'ritenuta';
    if (/reverse/i.test(group.note)) type = 'reverse_charge';
    if (/strumentale|ammortizz/i.test(group.note)) type = 'bene_strumentale';

    const options: FiscalAlertOption[] = [];
    if (type === 'deducibilita') {
      options.push(
        { label: `Conservativo (${group.deducPct}% deduc., ${group.ivaPct}% IVA)`, fiscal_override: { deducibilita_pct: group.deducPct, iva_detraibilita_pct: group.ivaPct }, is_default: true },
        { label: 'Mezzo da trasporto (100%/100%)', fiscal_override: { deducibilita_pct: 100, iva_detraibilita_pct: 100 }, is_default: false },
      );
    } else if (type === 'bene_strumentale') {
      options.push(
        { label: 'Costo d\'esercizio (deduzione immediata)', fiscal_override: { bene_strumentale: false }, is_default: true },
        { label: 'Bene strumentale (ammortamento)', fiscal_override: { bene_strumentale: true }, is_default: false },
      );
    } else if (type === 'ritenuta') {
      options.push(
        { label: 'Con ritenuta d\'acconto', fiscal_override: { ritenuta_acconto: true }, is_default: true },
        { label: 'Senza ritenuta', fiscal_override: { ritenuta_acconto: false }, is_default: false },
      );
    }

    // Skip if already covered by Sonnet
    const alreadyCovered = alerts.some(a =>
      a.type === type && a.affected_lines.some(id => group.lineIds.includes(id))
    );
    if (alreadyCovered || options.length === 0) continue;

    alerts.push({
      type,
      severity: 'warning',
      title: type === 'deducibilita' ? 'Deducibilit\u00E0 da verificare'
        : type === 'bene_strumentale' ? 'Possibile bene strumentale'
        : type === 'ritenuta' ? 'Ritenuta d\'acconto'
        : 'Nota fiscale',
      description: group.note,
      current_choice: options[0].label,
      options,
      affected_lines: group.lineIds,
    });
  }

  return alerts;
}

type InvoiceDetailPhase = 'idle' | 'loading' | 'ready' | 'refreshing';

type InvoiceLineArticleAssignmentRow = {
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

type InvoiceDetailBundle = {
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

type InvoiceReferenceData = {
  articles: ArticleWithPhases[]
  learnedRules: LearnedRule[]
  categories: Category[]
  projects: Project[]
  accounts: ChartAccount[]
}

const EMPTY_INVOICE_CLASSIF_META: InvoiceClassificationMeta = {
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

const EMPTY_INVOICE_REFERENCE_DATA: InvoiceReferenceData = {
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

function hasAnyLineProjects(lineProjects: Record<string, LineProjectAssignment[]>): boolean {
  return Object.values(lineProjects).some(assignments => assignments.length > 0);
}

type PendingFiscalChoice = {
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

function InvoiceDetail({ invoice, detailBundle, detailPhase, referenceData, referenceDataLoading, onInvalidateBundle, onEdit, onDelete, onReload, onPatchInvoice, onRefreshBadges, onSetClassifMeta, onOpenCounterparty, onOpenScadenzario, onNavigateCounterparty }: {
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
  const [activeTab, setActiveTab] = useState<DetailTab>('classificazione');
  const [editing, setEditing] = useState(false);
  const [showXml, setShowXml] = useState(false);
  const [parsed, setParsed] = useState<any>(null);
  // Notes tab state
  const [notesText, setNotesText] = useState(invoice.notes || '');
  const [notesSaving, setNotesSaving] = useState(false);
  // Expandable line detail state
  const [expandedLines, setExpandedLines] = useState<Record<string, boolean>>({});
  const toggleLineExpand = useCallback((lineId: string) => {
    setExpandedLines(prev => ({ ...prev, [lineId]: !prev[lineId] }));
  }, []);
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
  ), [classification, lineClassifs, lineArticleMap, aiSuggestions, lineProjects, cdcRows, invProjects]);

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
        fiscal_flags: lr.fiscal_flags,
        suggest_new_account: lr.suggest_new_account,
        suggest_new_category: lr.suggest_new_category,
      }));

      const classified = pipelineResult.lines.filter(l => l.confidence >= 60 && (l.category_id || l.account_id));
      const best = classified.length > 0
        ? classified.reduce((a, b) => b.confidence > a.confidence ? b : a)
        : null;

      const result = {
        invoice_id: runInvoiceId,
        lines: mergedLines,
        invoice_level: best ? {
          category_id: best.category_id,
          account_id: best.account_id,
          project_allocations: best.cost_center_allocations || [],
          confidence: best.confidence,
          reasoning: `Pipeline v2: ${pipelineResult.stats.deterministic} deterministiche, ${pipelineResult.stats.ai_classified} AI`,
        } : {
          category_id: null, account_id: null, project_allocations: [],
          confidence: 0, reasoning: 'Nessuna classificazione riuscita',
        },
      };

      setAiClassifResult(result);
      setAiClassifStatus('done');
      if (pipelineResult.debug) setPipelineDebug(pipelineResult.debug);
      onPatchInvoice(runInvoiceId, { classification_status: 'ai_suggested' } as Partial<DBInvoice>);
      onInvalidateBundle(runInvoiceId);

      const flags: Record<string, any> = {};
      for (const lr of mergedLines) {
        if (lr.fiscal_flags && lr.invoice_line_id) {
          flags[lr.invoice_line_id] = lr.fiscal_flags;
        }
      }
      setLineFiscalFlags(flags);

      const confs: Record<string, number> = {};
      const reviews: Record<string, boolean> = {};
      for (const lr of (result.lines || [])) {
        const lid = lr.line_id || lr.invoice_line_id;
        if (lid) {
          if (lr.confidence != null) confs[lid] = lr.confidence;
          reviews[lid] = lr.confidence < 65
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
          await deactivateInvoiceMemoryFacts(invoice.id);
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
          await deactivateInvoiceMemoryFacts(invoice.id, ['invoice_classification']);
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
            await deactivateInvoiceMemoryFacts(invoice.id, ['invoice_fiscal_choice']);
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
    setAiClassifStatus('idle');
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
      await deactivateInvoiceMemoryFacts(invoice.id);
    } catch (e) {
      console.warn('[clear] Error deactivating invoice memory facts:', e);
    }
    onInvalidateBundle(invoice.id);
  }, [invoice?.id, onInvalidateBundle]);

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
    <div className="flex flex-col h-full" id="invoice-detail-print">
	      {/* HEADER — Test Lab inspired */}
	      <div className="bg-white border-b flex-shrink-0">
	        {/* Top bar: actions */}
	        <div className="flex items-center justify-between px-4 pt-3 pb-1">
	          <div className="flex items-center gap-1.5 flex-wrap">
	            {counterpartyHeaderInfo.atecoDescription && (
	              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 border border-blue-200">
	                {counterpartyHeaderInfo.atecoDescription}
	              </span>
	            )}
	            {counterpartyHeaderInfo.provinceSigla && (
	              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200">
	                {counterpartyHeaderInfo.provinceSigla}
	              </span>
	            )}
	            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md ${
	              invoice.direction === 'in' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
	            }`}>
	              {invoice.direction === 'in' ? 'Passiva' : 'Attiva'}
	            </span>
	            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md ${STATUS_COLORS[invoice.payment_status] || 'bg-gray-100 text-gray-600'}`}>
	              {getStatusLabel(invoice.payment_status, invoice.direction)}
	            </span>
	          </div>
	          <div className="flex items-center gap-1">
            {detail?.raw_xml && (
              <button onClick={() => setShowXml(!showXml)} className={`w-8 h-8 flex items-center justify-center rounded-md border text-xs ${showXml ? 'bg-sky-600 text-white border-sky-600' : 'border-gray-200 hover:bg-gray-50 text-gray-500'}`} title="Vedi XML">&lt;/&gt;</button>
            )}
            {detail?.raw_xml && (
              <button onClick={downloadXml} className="w-8 h-8 flex items-center justify-center rounded-md border border-gray-200 hover:bg-gray-50 text-gray-500 text-sm" title="Scarica XML">{'\u2B07'}</button>
            )}
            <button onClick={() => window.print()} className="w-8 h-8 flex items-center justify-center rounded-md border border-gray-200 hover:bg-gray-50 text-gray-500 text-sm" title="Stampa PDF">{'\uD83D\uDDA8'}</button>
            <button onClick={() => setEditing(!editing)} className={`w-8 h-8 flex items-center justify-center rounded-md border text-sm ${editing ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 hover:bg-gray-50 text-gray-500'}`} title="Modifica">{'\u270F'}</button>
            <button onClick={onOpenScadenzario} className="w-8 h-8 flex items-center justify-center rounded-md border border-gray-200 hover:bg-gray-50 text-gray-500 text-sm" title="Scadenzario">{'\uD83D\uDCC5'}</button>
            <button onClick={onDelete} className="w-8 h-8 flex items-center justify-center rounded-md border border-red-200 hover:bg-red-50 text-red-400 text-sm" title="Elimina">{'\uD83D\uDDD1'}</button>
          </div>
        </div>
        {/* Counterparty + invoice summary */}
        <div className="px-4 pb-2">
          <button
            onClick={onNavigateCounterparty}
            className="text-lg font-bold text-gray-900 hover:text-blue-700 hover:underline cursor-pointer bg-transparent border-none p-0 text-left truncate max-w-[360px]"
            title="Vai alla controparte"
          >
            {cp?.denom || invoice.source_filename || 'Sconosciuto'}
          </button>
          {cp?.piva && <span className="text-[10px] text-gray-400 ml-2">P.IVA {cp.piva}</span>}
        </div>
        {/* Structured data grid */}
        <div className="grid grid-cols-6 gap-3 px-4 pb-3 text-[11px]">
          <div>
            <span className="text-gray-400 text-[10px] block">Tipo doc</span>
            <p className="font-semibold text-gray-700">{tpLabel(invoice.doc_type) || invoice.doc_type}</p>
          </div>
          <div>
            <span className="text-gray-400 text-[10px] block">Numero</span>
            <p className="font-semibold text-gray-700">{invoice.number || '\u2014'}</p>
          </div>
          <div>
            <span className="text-gray-400 text-[10px] block">Data</span>
            <p className="font-semibold text-gray-700">{fmtDate(invoice.date)}</p>
          </div>
          <div>
            <span className="text-gray-400 text-[10px] block">Totale</span>
            <p className="font-bold text-gray-900">{fmtEur(invoice.total_amount)}</p>
          </div>
          <div>
            <span className="text-gray-400 text-[10px] block">Scadenza</span>
            <p className="font-semibold text-gray-700">{invoice.payment_due_date ? fmtDate(invoice.payment_due_date) : '\u2014'}</p>
          </div>
          <div>
            <span className="text-gray-400 text-[10px] block">Stato</span>
            <p className="font-semibold text-gray-700">{getStatusLabel(invoice.payment_status, invoice.direction)}</p>
          </div>
        </div>
      </div>

      {/* TAB BAR */}
      <div className="flex border-b bg-white flex-shrink-0 px-4">
        {DETAIL_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'text-blue-700 border-blue-600'
                : 'text-gray-400 border-transparent hover:text-gray-600'
            }`}
          >
            <span>{tab.icon}</span>
            <span>{tab.label}</span>
            {tab.key === 'classificazione' && classifNeedsAttention && (
              <span className="w-2 h-2 rounded-full bg-orange-400 flex-shrink-0" />
            )}
          </button>
        ))}
      </div>

      {/* TAB CONTENT (scrollable) */}
      <div className="flex-1 overflow-y-auto">
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
        {/* ═══ TAB: CLASSIFICAZIONE ═══ */}
        {activeTab === 'classificazione' && (
          <div className="p-4 space-y-4">
            {/* AI classification controls — compact bar */}
            <div className="flex items-center gap-3 flex-wrap">
              {/* AI Suggest button */}
              {aiClassifStatus === 'idle' && !aiClassifResult && (
                <button onClick={handleRequestAiClassification}
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold rounded-lg bg-gradient-to-r from-purple-600 to-indigo-600 text-white hover:from-purple-700 hover:to-indigo-700 shadow-md transition-all">
                  <span>{'\u2728'}</span> Suggerisci AI
                </button>
              )}
              {aiClassifStatus === 'loading' && !singleInvoiceJobRunning && (
                <div className="flex items-center gap-2 text-xs text-purple-600">
                  <span className="animate-spin">{'\u21BB'}</span> Classificazione AI...
                </div>
              )}
              {singleInvoiceJobRunning && singleInvoiceJob && (
                <div className="flex items-center gap-2 text-xs text-purple-700">
                  <span className="animate-spin">{'\u21BB'}</span>
                  <span>{singleInvoiceJob.stage || 'Classificazione AI in corso'}</span>
                  <span className="text-purple-500">{singleInvoiceJobProgress.pct}%</span>
                </div>
              )}
              {aiClassifStatus === 'error' && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-red-600">Errore AI</span>
                  <button onClick={() => setAiClassifStatus('idle')} className="text-xs text-sky-600 hover:underline">Riprova</button>
                </div>
              )}

              {/* AI result info */}
              {aiClassifResult && (
                <div className="flex items-center gap-2 bg-purple-50 border border-purple-200 rounded-lg px-2.5 py-1.5">
                  <span className="text-purple-600 text-sm">{'\u2728'}</span>
                  <span className="text-[10px] text-purple-700">
                    {aiClassifResult.invoice_level?.reasoning || 'AI applicata'}
                  </span>
                  <span className="text-[10px] text-purple-500">
                    {aiClassifResult.invoice_level?.confidence ?? 0}%
                  </span>
                  {aiClassifResult.stats?.sonnet_escalated > 0 && (
                    <span className="text-[9px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-medium">
                      {aiClassifResult.stats.sonnet_escalated} Sonnet
                    </span>
                  )}
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

            {singleInvoiceJobRunning && singleInvoiceJob && (
              <SingleInvoiceAIProgressCard job={singleInvoiceJob} onStop={stopSingleInvoiceJob} />
            )}

            {/* AI Assistant Box — always visible, 3 states */}
            {(() => {
              const hasAlerts = invoiceNotes.length > 0 || !!(invoice as any).has_fiscal_alerts;
              const isClassified = invoice.classification_status === 'confirmed' || hasPersistedClassificationData || !!aiClassifResult;
              const boxStyle = hasAlerts
                ? 'border-amber-200 bg-amber-50'
                : isClassified
                  ? 'border-green-200 bg-green-50'
                  : 'border-gray-200 bg-gray-50';
              return (
                <div className={`border rounded-xl px-4 py-3 mb-3 ${boxStyle}`}>
                  {/* Header */}
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-base">{'\uD83E\uDDE0'}</span>
                      <span className="text-xs font-bold text-gray-700">Assistente AI</span>
                    </div>
                    {isClassified && !hasAlerts && (
                      <span className="text-green-500 text-sm">{'\u2705'}</span>
                    )}
                    {hasAlerts && (
                      <span className="text-amber-500 text-sm">{'\u26A0\uFE0F'}</span>
                    )}
                  </div>

                  {/* State 1: No classification yet */}
                  {!isClassified && !hasAlerts && (
                    <p className="text-[11px] text-gray-500">
                      Clicca "Suggerisci AI" per classificare questa fattura.
                    </p>
                  )}

                  {/* State 2: Classified, no alerts */}
                  {isClassified && !hasAlerts && (
                    <p className="text-[11px] text-gray-500">
                      {invoice.classification_status === 'confirmed'
                        ? 'Classificazione confermata.'
                        : 'Classificazione completata. Nessuna nota fiscale particolare.'}
                    </p>
                  )}

                  {/* State 3: Classified with alerts */}
                  {hasAlerts && (
                    <div className="mt-1 space-y-2">
                      <p className="text-[11px] text-amber-700 font-medium">
                        {invoiceNotes.length > 0
                          ? `${invoiceNotes.length} alert da verificare`
                          : 'Note fiscali presenti \u2014 riclassifica per visualizzarle'}
                      </p>
                      {invoiceNotes.map((alert, idx) => (
                        <div key={idx} className="bg-white border border-amber-200 rounded-lg px-3 py-2">
                          <div className="flex items-start gap-2">
                            <span className="text-amber-500 text-xs mt-0.5">{alert.severity === 'warning' ? '\u26A0\uFE0F' : '\u2139\uFE0F'}</span>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-semibold text-gray-800">{alert.title}</p>
                              <p className="text-[10px] text-gray-500 mt-0.5">{alert.description}</p>
                              <div className="flex flex-wrap gap-1.5 mt-2">
                                {alert.options.map((opt, optIdx) => (
                                  <button
                                    key={optIdx}
                                    onClick={() => handleFiscalChoice(idx, opt)}
                                    className={`text-[10px] px-2.5 py-1 rounded-md font-medium transition-colors ${
                                      opt.isConservative === true || opt.is_default
                                        ? 'bg-green-50 text-green-700 border border-green-300 hover:bg-green-100'
                                        : opt.isConservative === false
                                          ? 'bg-gray-100 text-gray-700 border border-gray-200 hover:bg-gray-200'
                                          : opt.is_default
                                            ? 'bg-amber-100 text-amber-800 border border-amber-300 hover:bg-amber-200'
                                            : 'bg-gray-100 text-gray-700 border border-gray-200 hover:bg-gray-200'
                                    }`}
                                  >
                                    {opt.isConservative === true && '\u2705 '}{opt.label}
                                  </button>
                                ))}
                                <button
                                  onClick={() => handleFiscalChoice(idx, null)}
                                  className="text-[10px] px-2 py-1 text-gray-400 hover:text-gray-600 transition-colors"
                                >
                                  Salta
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Pipeline Debug Panel — visible only after fresh classification */}
            {pipelineDebug && pipelineDebug.length > 0 && (
              <details className="mb-3 border border-slate-200 rounded-xl overflow-hidden">
                <summary className="px-4 py-2.5 bg-slate-50 cursor-pointer text-sm font-semibold text-slate-700 hover:bg-slate-100 flex items-center gap-2">
                  <span className="text-base">{'\uD83D\uDD0D'}</span>
                  Dettagli Pipeline AI ({pipelineDebug.length} step)
                </summary>
                <div className="p-4 space-y-3 bg-white">
                  {pipelineDebug.map((step, i) => (
                    <PipelineStepDetailPanel key={i} step={step} />
                  ))}
                </div>
              </details>
            )}

            {/* Invoice lines table with classification */}
            <div className="bg-white border rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b bg-gray-50">
                <h3 className="text-sm font-bold text-gray-800">Righe fattura</h3>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-emerald-600 font-medium">
                    {visibleLineCount} righe
                    {(hiddenLineCount > 0 || showZeroLines) && (
                      <button onClick={() => setShowZeroLines(!showZeroLines)}
                        className="ml-1 text-gray-400 hover:text-gray-600 underline">
                        {showZeroLines ? 'nascondi righe a zero' : `+${hiddenLineCount} a zero`}
                      </button>
                    )}
                  </span>
                  <span className="text-[11px] text-gray-400">
                    {classifiedLineCount}/{visibleLineCount - informationalTotal} classificate
                    {informationalTotal > 0 && (
                      <span className="ml-1 text-gray-300">
                        ({groupedLineCount > 0 ? `${groupedLineCount} rif.` : ''}{groupedLineCount > 0 && skippedLineCount > 0 ? ', ' : ''}{skippedLineCount > 0 ? `${skippedLineCount} info` : ''})
                      </span>
                    )}
                  </span>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[11px]">
                  <thead><tr className="bg-gray-50 border-b">
                    <th className="text-left px-3 py-2 text-gray-600 font-semibold">Descrizione</th>
                    <th className="text-right px-2 py-2 text-gray-600 font-semibold w-14">Qt{'\u00E0'}</th>
                    <th className="text-right px-2 py-2 text-gray-600 font-semibold w-16">P. Unit.</th>
                    <th className="text-right px-2 py-2 text-gray-600 font-semibold w-14">IVA</th>
                    <th className="text-right px-2 py-2 text-gray-600 font-semibold w-16">Totale</th>
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
                    {(allCategories.length > 0 || allAccounts.length > 0) && <th className="text-center px-0.5 py-2 text-gray-400 font-normal w-12"></th>}
                  </tr></thead>
                  <tbody>
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
                      const hasFiscalFlags = !isInformational && ff && (ff.ritenuta_acconto || ff.reverse_charge || ff.split_payment || ff.bene_strumentale || (ff.deducibilita_pct != null && ff.deducibilita_pct < 100) || (ff.iva_detraibilita_pct != null && ff.iva_detraibilita_pct < 100));
                      const colCount = 5 + (allCategories.length > 0 ? 1 : 0) + (allProjects.length > 0 ? 1 : 0) + (allAccounts.length > 0 ? 1 : 0) + ((allCategories.length > 0 || allAccounts.length > 0) ? 1 : 0);

                      // ─── Skip/Group informational lines: special rendering ───
                      if (isInformational) {
                        return (
                          <React.Fragment key={`info-${i}`}>
                            <tr className={`border-b border-gray-50 ${isSkip ? 'bg-gray-50/50 opacity-50' : 'bg-blue-50/20'}`}>
                              <td className="text-left px-3 py-1.5 max-w-[200px]">
                                {isGroup && <span className="text-gray-400 mr-1">{'\u21B3'}</span>}
                                <span className={`${isSkip ? 'text-gray-400 line-through' : 'text-gray-500 italic'}`}>
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
                            </tr>
                          </React.Fragment>
                        );
                      }

                      // ─── Normal classify line rendering ───
                      return (
                      <React.Fragment key={i}>
                      <tr className="border-b border-gray-50 hover:bg-gray-50/50">
                        <td className="text-left px-3 py-2 max-w-[200px]">
                          {lineId && (
                            <button
                              onClick={() => toggleLineExpand(lineId)}
                              className="inline-flex items-center justify-center w-4 h-4 mr-1.5 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50 text-[9px] align-middle"
                              title={expandedLines[lineId] ? 'Comprimi dettagli' : 'Espandi dettagli'}
                            >
                              {expandedLines[lineId] ? '▼' : '▶'}
                            </button>
                          )}
                          <span className="text-gray-800">{l.descrizione}</span>
                          {lineId && <ConfidenceBadge value={lineConfidences[lineId]} />}
                          {lineId && <ReviewBadge
                            confidence={lineConfidences[lineId]}
                            hasNote={!!(ff?.note && /verificar|controllare|dubbio/i.test(ff.note || ''))}
                            needsReview={lineReviewFlags[lineId]}
                          />}
                          {/* Article badge + phase dropdown inline */}
                          {lineId && articles.length > 0 && (
                            <span className="ml-1.5 inline-flex items-center gap-1 align-middle flex-wrap">
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
                              {/* Cascading phase dropdown — only for multi-step articles */}
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
                        </td>
                        <td className={`text-right px-2 py-2 ${safeFloat(l.prezzoTotale) < 0 && lineId && lineArticleMap[lineId] ? 'text-gray-300 line-through' : 'text-gray-600'}`}>
                          {l.quantita ? fmtNum(safeFloat(l.quantita)) : '1'}
                          {safeFloat(l.prezzoTotale) < 0 && lineId && lineArticleMap[lineId] && (
                            <span title="Riga esclusa dal conteggio quantità (importo negativo — sconto/abbuono)" className="ml-0.5 text-red-400 text-[9px] cursor-help no-underline" style={{ textDecoration: 'none' }}>✕</span>
                          )}
                        </td>
                        <td className="text-right px-2 py-2 text-gray-600">{fmtNum(safeFloat(l.prezzoUnitario))}</td>
                        <td className="text-right px-2 py-2 text-gray-600">{fmtNum(safeFloat(l.aliquotaIVA))}%</td>
                        <td className={`text-right px-2 py-2 font-bold ${safeFloat(l.prezzoTotale) < 0 ? 'text-red-600' : 'text-gray-800'}`}>{fmtNum(safeFloat(l.prezzoTotale))}</td>
                        {allCategories.length > 0 && <td className={`text-center px-1 py-1${lineId && lineConfidences[lineId] != null && lineConfidences[lineId] < 50 ? ' opacity-40' : ''}`}>
                          {lineId ? (
                            <SearchableSelect
                              value={lineCat || null}
                              options={dirCategories.map(c => ({ id: c.id, label: c.name }))}
                              onChange={v => handleLineClassifChange(lineId, 'category_id', v)}
                              placeholder={selCategoryId ? '\u2190 Fatt.' : '\u2014'}
                              emptyLabel={selCategoryId ? '\u2190 Fatt.' : undefined}
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
                                  ? lineProjects[lineId].map(lp => { const p = allProjects.find(pp => pp.id === lp.project_id); return p ? `${p.code} ${p.name?.substring(0, 8) || ''}` : ''; }).filter(Boolean).join(', ').substring(0, 18)
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
                              selectedClassName="bg-emerald-50 border-emerald-200 text-emerald-700 font-semibold"
                              emptyClassName="border-gray-200 bg-white text-gray-500"
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
                      </tr>
                      {hasFiscalFlags && (
                        <tr>
                          <td colSpan={colCount} className="px-3 py-1">
                            <div className="flex flex-wrap gap-1.5">
                              {ff.ritenuta_acconto && (
                                <span className="inline-flex items-center gap-1 bg-amber-50 border border-amber-200 text-amber-800 text-[10px] px-2 py-0.5 rounded">
                                  {'\u26A0\uFE0F'} Ritenuta d'acconto {ff.ritenuta_acconto.aliquota}% sull'imponibile
                                </span>
                              )}
                              {ff.reverse_charge && (
                                <span className="inline-flex items-center gap-1 bg-amber-50 border border-amber-200 text-amber-800 text-[10px] px-2 py-0.5 rounded">
                                  {'\u26A0\uFE0F'} Possibile reverse charge art.17 c.6
                                </span>
                              )}
                              {ff.split_payment && (
                                <span className="inline-flex items-center gap-1 bg-amber-50 border border-amber-200 text-amber-800 text-[10px] px-2 py-0.5 rounded">
                                  {'\u26A0\uFE0F'} Split payment — IVA versata dalla PA
                                </span>
                              )}
                              {ff.bene_strumentale && (
                                <span className="inline-flex items-center gap-1 bg-amber-50 border border-amber-200 text-amber-800 text-[10px] px-2 py-0.5 rounded">
                                  {'\u26A0\uFE0F'} Possibile bene strumentale ({'>'}516{'\u20AC'}) — da ammortizzare
                                </span>
                              )}
                              {ff.deducibilita_pct != null && ff.deducibilita_pct < 100 && (
                                <span className="inline-flex items-center gap-1 bg-sky-50 border border-sky-200 text-sky-800 text-[10px] px-2 py-0.5 rounded">
                                  {'\u2139\uFE0F'} Costo deducibile al {ff.deducibilita_pct}%
                                </span>
                              )}
                              {ff.iva_detraibilita_pct != null && ff.iva_detraibilita_pct < 100 && (
                                <span className="inline-flex items-center gap-1 bg-sky-50 border border-sky-200 text-sky-800 text-[10px] px-2 py-0.5 rounded">
                                  {'\u2139\uFE0F'} IVA detraibile al {ff.iva_detraibilita_pct}%
                                </span>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                      {/* Expandable detail row: Commercialista + Revisore + Note (XML lines) */}
                      {lineId && expandedLines[lineId] && (
                        <tr>
                          <td colSpan={colCount} className="bg-slate-50/80 px-4 py-3 border-b border-slate-200">
                            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                              <ReasoningBox
                                icon="🏦"
                                title="Commercialista"
                                confidence={lineConfidences[lineId] ?? null}
                                reasoning={lineDetails[lineId]?.classification_reasoning || null}
                                thinking={lineDetails[lineId]?.classification_thinking || null}
                                variant="blue"
                              />
                              <FiscalBox
                                icon="⚖️"
                                title="Revisore Fiscale"
                                confidence={lineDetails[lineId]?.fiscal_confidence ?? null}
                                reasoning={lineDetails[lineId]?.fiscal_reasoning || null}
                                thinking={lineDetails[lineId]?.fiscal_thinking || null}
                                fiscalFlags={ff || null}
                              />
                              <NoteBox
                                lineId={lineId}
                                note={lineDetails[lineId]?.line_note || null}
                                noteSource={lineDetails[lineId]?.line_note_source || null}
                                noteUpdatedAt={lineDetails[lineId]?.line_note_updated_at || null}
                                onSave={(note) => handleSaveLineNote(lineId, note)}
                              />
                            </div>
                          </td>
                        </tr>
                      )}
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
                      const hasFf2 = !isInformational && ff2 && (ff2.ritenuta_acconto || ff2.reverse_charge || ff2.split_payment || ff2.bene_strumentale || (ff2.deducibilita_pct != null && ff2.deducibilita_pct < 100) || (ff2.iva_detraibilita_pct != null && ff2.iva_detraibilita_pct < 100));
                      const colCount2 = 5 + (allCategories.length > 0 ? 1 : 0) + (allProjects.length > 0 ? 1 : 0) + (allAccounts.length > 0 ? 1 : 0) + ((allCategories.length > 0 || allAccounts.length > 0) ? 1 : 0);

                      // ─── Skip/Group informational lines: special rendering ───
                      if (isInformational) {
                        return (
                          <React.Fragment key={`db-info-${i}`}>
                            <tr className={`border-b border-gray-50 ${isSkip ? 'bg-gray-50/50 opacity-50' : 'bg-blue-50/20'}`}>
                              <td className="text-left px-3 py-1.5">
                                {isGroup && <span className="text-gray-400 mr-1">{'\u21B3'}</span>}
                                <span className={`${isSkip ? 'text-gray-400 line-through' : 'text-gray-500 italic'}`}>
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
                            </tr>
                          </React.Fragment>
                        );
                      }

                      // ─── Normal classify line rendering ───
                      return (
                      <React.Fragment key={i}>
                      <tr className="border-b border-gray-50 hover:bg-gray-50/50">
                        <td className="text-left px-3 py-2">
                          <button
                            onClick={() => toggleLineExpand(l.id)}
                            className="inline-flex items-center justify-center w-4 h-4 mr-1.5 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50 text-[9px] align-middle"
                            title={expandedLines[l.id] ? 'Comprimi dettagli' : 'Espandi dettagli'}
                          >
                            {expandedLines[l.id] ? '▼' : '▶'}
                          </button>
                          <span className="text-gray-800">{l.description}</span>
                          <ConfidenceBadge value={lineConfidences[l.id]} />
                          <ReviewBadge
                            confidence={lineConfidences[l.id]}
                            hasNote={!!(ff2?.note && /verificar|controllare|dubbio/i.test(ff2.note || ''))}
                            needsReview={lineReviewFlags[l.id]}
                          />
                          {articles.length > 0 && (
                            <span className="ml-1.5 inline-flex items-center gap-1 align-middle flex-wrap">
                              <ArticleDropdown articles={articles} current={lineArticleMap[l.id] || null} suggestion={aiSuggestions[l.id] || null}
                                onAssign={(artId, sugPhaseId) => handleAssignArticle(l.id, artId, l.description, { quantity: l.quantity, unit_price: l.unit_price, total_price: l.total_price, vat_rate: l.vat_rate }, sugPhaseId)}
                                onRemove={() => handleRemoveArticle(l.id)}
                                onDismissSuggestion={() => handleDismissArticleSuggestion(l.id)} />
                              {/* Cascading phase dropdown — only for multi-step articles */}
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
                        </td>
                        <td className={`text-right px-2 py-2 ${(l.total_price ?? 0) < 0 && lineArticleMap[l.id] ? 'text-gray-300 line-through' : 'text-gray-600'}`}>
                          {fmtNum(l.quantity)}
                          {(l.total_price ?? 0) < 0 && lineArticleMap[l.id] && (
                            <span title="Riga esclusa dal conteggio quantità (importo negativo — sconto/abbuono)" className="ml-0.5 text-red-400 text-[9px] cursor-help no-underline" style={{ textDecoration: 'none' }}>✕</span>
                          )}
                        </td>
                        <td className="text-right px-2 py-2 text-gray-600">{fmtNum(l.unit_price)}</td>
                        <td className="text-right px-2 py-2 text-gray-600">{fmtNum(l.vat_rate)}%</td>
                        <td className={`text-right px-2 py-2 font-bold ${(l.total_price ?? 0) < 0 ? 'text-red-600' : 'text-gray-800'}`}>{fmtNum(l.total_price)}</td>
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
                      </tr>
                      {/* Expandable detail row: Commercialista + Revisore + Note */}
                      {expandedLines[l.id] && (
                        <tr>
                          <td colSpan={colCount2} className="bg-slate-50/80 px-4 py-3 border-b border-slate-200">
                            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                              <ReasoningBox
                                icon="🏦"
                                title="Commercialista"
                                confidence={lineConfidences[l.id] ?? null}
                                reasoning={lineDetails[l.id]?.classification_reasoning || null}
                                thinking={lineDetails[l.id]?.classification_thinking || null}
                                variant="blue"
                              />
                              <FiscalBox
                                icon="⚖️"
                                title="Revisore Fiscale"
                                confidence={lineDetails[l.id]?.fiscal_confidence ?? null}
                                reasoning={lineDetails[l.id]?.fiscal_reasoning || null}
                                thinking={lineDetails[l.id]?.fiscal_thinking || null}
                                fiscalFlags={ff2 || null}
                              />
                              <NoteBox
                                lineId={l.id}
                                note={lineDetails[l.id]?.line_note || null}
                                noteSource={lineDetails[l.id]?.line_note_source || null}
                                noteUpdatedAt={lineDetails[l.id]?.line_note_updated_at || null}
                                onSave={(note) => handleSaveLineNote(l.id, note)}
                              />
                            </div>
                          </td>
                        </tr>
                      )}
                      {hasFf2 && (
                        <tr>
                          <td colSpan={colCount2} className="px-3 py-1">
                            <div className="flex flex-wrap gap-1.5">
                              {ff2.ritenuta_acconto && (
                                <span className="inline-flex items-center gap-1 bg-amber-50 border border-amber-200 text-amber-800 text-[10px] px-2 py-0.5 rounded">
                                  {'\u26A0\uFE0F'} Ritenuta d'acconto {ff2.ritenuta_acconto.aliquota}% sull'imponibile
                                </span>
                              )}
                              {ff2.reverse_charge && (
                                <span className="inline-flex items-center gap-1 bg-amber-50 border border-amber-200 text-amber-800 text-[10px] px-2 py-0.5 rounded">
                                  {'\u26A0\uFE0F'} Possibile reverse charge art.17 c.6
                                </span>
                              )}
                              {ff2.split_payment && (
                                <span className="inline-flex items-center gap-1 bg-amber-50 border border-amber-200 text-amber-800 text-[10px] px-2 py-0.5 rounded">
                                  {'\u26A0\uFE0F'} Split payment — IVA versata dalla PA
                                </span>
                              )}
                              {ff2.bene_strumentale && (
                                <span className="inline-flex items-center gap-1 bg-amber-50 border border-amber-200 text-amber-800 text-[10px] px-2 py-0.5 rounded">
                                  {'\u26A0\uFE0F'} Possibile bene strumentale ({'>'}516{'\u20AC'}) — da ammortizzare
                                </span>
                              )}
                              {ff2.deducibilita_pct != null && ff2.deducibilita_pct < 100 && (
                                <span className="inline-flex items-center gap-1 bg-sky-50 border border-sky-200 text-sky-800 text-[10px] px-2 py-0.5 rounded">
                                  {'\u2139\uFE0F'} Costo deducibile al {ff2.deducibilita_pct}%
                                </span>
                              )}
                              {ff2.iva_detraibilita_pct != null && ff2.iva_detraibilita_pct < 100 && (
                                <span className="inline-flex items-center gap-1 bg-sky-50 border border-sky-200 text-sky-800 text-[10px] px-2 py-0.5 rounded">
                                  {'\u2139\uFE0F'} IVA detraibile al {ff2.iva_detraibilita_pct}%
                                </span>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
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
              {/* Footer */}
              <div className="flex items-center justify-between px-4 py-2.5 border-t bg-gray-50">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-gray-400">
                    {isPostConfirmDirty
                      ? '⚠ Modifiche non salvate'
                      : isConfirmed
                        ? '\u2713 Classificazione confermata'
                        : classification
                          ? '\u2713 Classificazione salvata'
                          : 'Nessuna classificazione'}
                  </span>
                  {/* "Cancella tutto" — clears entire classification (always visible when there's data) */}
                  {(persistedHasData || draftHasData || clearPending) && (
                    <button onClick={() => setShowClearDialog(true)}
                      className="px-2 py-1 text-[10px] font-semibold rounded-md border border-red-200 text-red-500 hover:bg-red-50 transition-colors">
                      {'\uD83D\uDDD1'} Cancella tutto
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {/* Universal "Salva" — visible whenever there are unsaved changes */}
                  {isPostConfirmDirty && (
                    <button onClick={handleConfirmChanges} disabled={confirmChangesSaving || !cdcValidation.valid}
                      className="px-5 py-2 text-sm font-bold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-md animate-pulse"
                      title={!cdcValidation.valid ? cdcValidation.message : 'Salva tutte le modifiche'}>
                      {confirmChangesSaving ? 'Salvataggio...' : '\uD83D\uDCBE Salva'}
                    </button>
                  )}
                  {/* No Conferma/Ignora — user uses universal Save button above */}
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

            {/* Dettaglio Beni e Servizi (read-only) */}
            <div className="bg-white border rounded-xl overflow-hidden">
              <h4 className="text-xs font-bold text-gray-700 px-4 py-2.5 border-b bg-gray-50">Dettaglio Beni e Servizi</h4>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[11px]">
                  <thead><tr className="bg-gray-50 border-b">
                    <th className="text-left px-3 py-2 text-gray-600 font-semibold">Descrizione</th>
                    <th className="text-right px-2 py-2 text-gray-600 font-semibold">Qt{'\u00E0'}</th>
                    <th className="text-right px-2 py-2 text-gray-600 font-semibold">P. Unit.</th>
                    <th className="text-right px-2 py-2 text-gray-600 font-semibold">IVA %</th>
                    <th className="text-right px-2 py-2 text-gray-600 font-semibold">Totale</th>
                  </tr></thead>
                  <tbody>
                    {(b?.linee || detail?.invoice_lines || []).map((l: any, i: number) => (
                      <tr key={i} className="border-b border-gray-50">
                        <td className="text-left px-3 py-1.5">{l.descrizione || l.description}</td>
                        <td className="text-right px-2 py-1.5">{fmtNum(safeFloat(l.quantita ?? l.quantity) || 1)}</td>
                        <td className="text-right px-2 py-1.5">{fmtNum(safeFloat(l.prezzoUnitario ?? l.unit_price))}</td>
                        <td className="text-right px-2 py-1.5">{fmtNum(safeFloat(l.aliquotaIVA ?? l.vat_rate))}%</td>
                        <td className="text-right px-2 py-1.5 font-bold">{fmtNum(safeFloat(l.prezzoTotale ?? l.total_price))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

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
                  <thead><tr className="bg-gray-50 border-b">
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
                .select('id, description, quantity, unit_price, total_price')
                .eq('invoice_id', inv.id)
                .order('line_number');
              if (!lines || lines.length === 0) return { ok: false };

              const cp = (inv.counterparty || {}) as any;

              // Run the v2 cascade pipeline (deterministic → understand → classify → CdC → fiscal review)
              await runClassificationPipeline(
                companyId,
                inv.id,
                lines.map(l => ({
                  line_id: l.id,
                  description: l.description,
                  quantity: l.quantity,
                  unit_price: l.unit_price,
                  total_price: l.total_price,
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
            .select('id, description, quantity, unit_price, total_price')
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
    <div className="h-full flex flex-col bg-gray-50">
      <ConfirmDeleteModal open={deleteModal.open} count={deleteModal.ids.length} onConfirm={handleDeleteConfirm} onCancel={() => setDeleteModal({ open: false, ids: [] })} />
      {companyId && <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} companyId={companyId} companyName={company?.name || 'Azienda'} />}
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-2 bg-white border-b shadow-sm flex-shrink-0 print:hidden">
        <h1 className="text-lg font-bold text-gray-800">Fatture</h1>
        {/* Segmented control Passive/Attive */}
        <div className="flex bg-gray-100 rounded-lg p-0.5">
          {([['in', 'Passive'], ['out', 'Attive']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setDirectionFilter(k)}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-all ${
                directionFilter === k
                  ? (k === 'in' ? 'bg-white text-orange-700 shadow-sm' : 'bg-white text-emerald-700 shadow-sm')
                  : 'text-gray-500 hover:text-gray-700'
              }`}>
              {label} <span className="font-normal">{tabCounts[k]}</span>
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {/* Inline stats */}
        <div className="flex items-center gap-1 text-xs text-gray-600">
          <span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" /><span>{stats.daPagare} {directionFilter === 'out' ? 'da incassare' : 'da pagare'}</span>
          <span className="text-gray-300 mx-1">|</span>
          <span className="w-2 h-2 rounded-full bg-red-400 inline-block" /><span>{stats.scadute} scadute</span>
          <span className="text-gray-300 mx-1">|</span>
          <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" /><span>{stats.pagate} {directionFilter === 'out' ? 'incassate' : 'pagate'}</span>
          <span className="text-gray-300 mx-1">|</span>
          <span className="font-bold text-gray-800">{fmtEur(stats.totalAmount)}</span>
        </div>
        {/* Action buttons */}
        <button
          onClick={runBatchAiClassification}
          title={batchClassifRunning ? 'Ferma classificazione' : 'Classifica automaticamente categoria, conto e CdC'}
          className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
            batchClassifRunning
              ? 'text-red-700 bg-red-50 border-red-200 hover:bg-red-100'
              : 'text-purple-700 bg-white border-purple-300 hover:bg-purple-50'
          }`}
        >
          {batchClassifRunning
            ? <>{'\u23F9'} Stop ({batchClassifJobProgress.pct}%)</>
            : <>{'\u2728'} Classifica AI</>
          }
        </button>
        <button onClick={() => setExportOpen(true)} className="px-3 py-1.5 text-xs font-semibold text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">
          Export
        </button>
        <button onClick={() => fileRef.current?.click()} className="px-3 py-1.5 text-xs font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700">+ Importa</button>
        <input ref={fileRef} type="file" multiple accept=".xml,.p7m,.zip" onChange={e => e.target.files && handleImport(e.target.files)} className="hidden" />
      </div>

      {importing && <div className="px-4 pt-3 print:hidden"><ImportProgress phase={importPhase} current={importCurrent} total={importTotal} logs={importLogs} /></div>}

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div className="w-[340px] border-r bg-white flex flex-col flex-shrink-0 print:hidden">
          <div className="p-2.5 border-b space-y-2">
            {/* Search bar */}
            <div className="relative">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-xs">{'\uD83D\uDD0D'}</span>
              <input
                value={query}
                onChange={e => handleQueryChange(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && query.trim()) handleAISearch(); }}
                placeholder="Cerca fattura o controparte..."
                className="w-full pl-7 pr-12 py-2 text-xs border rounded-lg bg-gray-50 outline-none focus:ring-1 focus:ring-blue-400"
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
        <div className="flex-1 flex flex-col overflow-hidden bg-gray-50">
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
	            onOpenCounterparty={(mode) => navigateToCounterparty(mode)}
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
