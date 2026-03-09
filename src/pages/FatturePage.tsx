// src/pages/FatturePage.tsx — v6
// Tab layout redesign: Classification-first UX with Documento/Pagamenti/Note tabs
import React, { useState, useCallback, useRef, useEffect, useMemo, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
import {
  subscribeExtraction, getExtractionState,
  loadExtractionStats as loadExtStats,
} from '@/lib/extractionStore';
import {
  loadArticlesWithPhases, assignArticleToLine, removeLineAssignment, recordAssignmentFeedback, loadLearnedRules,
  type Article, type ArticleWithPhases, type ArticlePhase, type MatchResult,
} from '@/lib/articlesService';
import { matchWithLearnedRules, extractLocation } from '@/lib/articleMatching';
import {
  loadCategories, loadProjects, loadChartOfAccounts,
  loadInvoiceClassification, saveInvoiceClassification, deleteInvoiceClassification,
  loadInvoiceProjects, saveInvoiceProjects,
  loadLineClassifications, saveLineCategoryAndAccount,
  loadLineProjects, saveLineProjects,
  CATEGORY_TYPE_LABELS, SECTION_LABELS,
  createAccountFromSuggestion, createCategoryFromSuggestion,
  type Category, type Project, type ChartAccount,
  type InvoiceClassification, type InvoiceProjectAssignment,
  type LineClassification, type LineProjectAssignment,
  type AccountSuggestion, type CategorySuggestion,
} from '@/lib/classificationService';
import { toast } from 'sonner';
import { createRuleFromConfirmation, findMatchingRules } from '@/lib/classificationRulesService';
import ExportDialog from '@/components/ExportDialog';

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
        <div><label className="block text-xs font-medium text-gray-600 mb-1">Stato</label><div className="w-full px-2 py-1.5 text-sm border rounded bg-gray-100 text-gray-600">{STATUS_LABELS[invoice.payment_status] || invoice.payment_status}</div></div>
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
// SIDEBAR CARD
// ============================================================
function InvoiceCard({ inv, selected, checked, selectMode, onSelect, onCheck, isMatched, suggestionScore, meta }: { inv: DBInvoice; selected: boolean; checked: boolean; selectMode: boolean; onSelect: () => void; onCheck: () => void; isMatched?: boolean; suggestionScore?: number; meta?: InvoiceClassificationMeta }) {
  const nc = inv.doc_type === 'TD04' || inv.doc_type === 'TD05';
  const cp = (inv.counterparty || {}) as any;
  const displayName = cp?.denom || inv.source_filename || 'Sconosciuto';
  // Classification started = at least one field present on at least one line
  const hasAnyField = meta && (
    meta.lines_with_category > 0 || meta.lines_with_account > 0 ||
    meta.lines_with_cdc > 0 || meta.lines_with_article > 0
  );
  const needsClassification = !hasAnyField && inv.classification_status !== 'ai_suggested';
  return (
    <div className={`flex items-start gap-2 px-3 py-2.5 cursor-pointer border-b border-gray-100 transition-all ${checked ? 'bg-blue-50 border-l-4 border-l-blue-500' : selected ? 'bg-sky-50 border-l-4 border-l-sky-500' : 'border-l-4 border-l-transparent hover:bg-gray-50'}`}>
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
            {nc && <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-red-100 text-red-700">NC</span>}
            <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${STATUS_COLORS[inv.payment_status] || 'bg-gray-100 text-gray-600'}`}>{STATUS_LABELS[inv.payment_status] || inv.payment_status}</span>
          </span>
        </div>
        {/* Classification chip badges */}
        <div className="flex items-center gap-1 mt-1 flex-wrap">
          {hasAnyField && meta ? (
            <>
              {/* Category badge */}
              {meta.has_category
                ? <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">Cat</span>
                : <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300">!Cat</span>}
              {/* CdC badge */}
              {meta.has_cost_center
                ? <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">CdC</span>
                : <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300">!CdC</span>}
              {/* Account badge */}
              {meta.has_account
                ? <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">Conto</span>
                : <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300">!Conto</span>}
              {/* Article badge */}
              {meta.has_article
                ? <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">Art</span>
                : <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300">!Art</span>}
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

function ArticleDropdown({ articles, current, suggestion, onAssign, onRemove }: {
  articles: ArticleWithPhases[]; current: LineArticleInfo | null;
  suggestion: MatchResult | null;
  onAssign: (articleId: string) => void; onRemove: () => void;
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
          <button onClick={() => { onAssign(suggestion!.article.id); setOpen(false); setSearch(''); }}
            className="w-full text-left px-2.5 py-1.5 text-[11px] bg-orange-50 text-orange-800 hover:bg-orange-100 border-b border-gray-100 flex items-center gap-1.5">
            <span>⚡</span>
            <span className="font-semibold">{suggestion!.article.code}</span>
            <span className="text-gray-500">— {suggestion!.article.name}</span>
            <span className="ml-auto text-[9px] text-orange-600">{Math.round(suggestion!.confidence)}%</span>
          </button>
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
        <button ref={btnRef} onClick={() => setOpen(!open)}
          className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-orange-50 text-orange-700 border border-orange-300 hover:bg-orange-100 transition-colors cursor-pointer whitespace-nowrap flex items-center gap-0.5">
          <span>⚡</span><span>{suggestion!.article.code}</span>
        </button>
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

function InvoiceDetail({ invoice, detail, installments, loadingDetail, onEdit, onDelete, onReload, onPatchInvoice, onOpenCounterparty, onOpenScadenzario, onNavigateCounterparty }: {
  invoice: DBInvoice; detail: DBInvoiceDetail | null; installments: InvoiceInstallment[]; loadingDetail: boolean;
  onEdit: (u: InvoiceUpdate) => Promise<void>; onDelete: () => void; onReload: () => void;
  onPatchInvoice: (invoiceId: string, patch: Partial<DBInvoice>) => void;
  onOpenCounterparty: (mode: 'verify' | 'edit') => void;
  onOpenScadenzario: () => void;
  onNavigateCounterparty: () => void;
}) {
  const { company } = useCompany();
  const [activeTab, setActiveTab] = useState<DetailTab>('classificazione');
  const [editing, setEditing] = useState(false);
  const [showXml, setShowXml] = useState(false);
  const [parsed, setParsed] = useState<any>(null);
  // Notes tab state
  const [notesText, setNotesText] = useState(invoice.notes || '');
  const [notesSaving, setNotesSaving] = useState(false);
  const notesDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // ─── Article assignment state ───
  const [articles, setArticles] = useState<ArticleWithPhases[]>([]);
  const [lineArticleMap, setLineArticleMap] = useState<Record<string, LineArticleInfo>>({});
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, MatchResult>>({});

  // ─── Classification state ───
  const [allCategories, setAllCategories] = useState<Category[]>([]);
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [allAccounts, setAllAccounts] = useState<ChartAccount[]>([]);
  const [classification, setClassification] = useState<InvoiceClassification | null>(null);
  const [invProjects, setInvProjects] = useState<InvoiceProjectAssignment[]>([]);
  const [selCategoryId, setSelCategoryId] = useState<string | null>(null);
  const [selAccountId, setSelAccountId] = useState<string | null>(null);
  const [classifDirty, setClassifDirty] = useState(false);
  const [classifSaving, setClassifSaving] = useState(false);
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
  // AI classification suggestion state
  const [aiClassifStatus, setAiClassifStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [aiClassifResult, setAiClassifResult] = useState<any>(null);
  const [lineFiscalFlags, setLineFiscalFlags] = useState<Record<string, any>>({});
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

  // Load articles + existing assignments when invoice changes
  useEffect(() => {
    const companyId = company?.id;
    if (!companyId || !invoice?.id) { setArticles([]); setLineArticleMap({}); setAiSuggestions({}); setBulkArticleId(null); setBulkPhaseId(null); return; }
    let cancelled = false;

    (async () => {
      // Load articles + learned rules for this company
      const [arts, rules] = await Promise.all([
        loadArticlesWithPhases(companyId, { activeOnly: true }),
        loadLearnedRules(companyId),
      ]);
      if (cancelled) return;
      setArticles(arts);

      // Load existing assignments for this invoice (include phase_id + phase relation)
      const { data: assignments } = await supabase
        .from('invoice_line_articles')
        .select('invoice_line_id, article_id, phase_id, assigned_by, verified, location, confidence, article:articles!inner(id, code, name, unit, keywords)')
        .eq('invoice_id', invoice.id);

      if (cancelled) return;
      const map: Record<string, LineArticleInfo> = {};
      const dbSuggestions: Record<string, MatchResult> = {};

      for (const a of (assignments || [])) {
        const art = a.article as any;
        // Resolve phase info from pre-loaded articles
        const fullArtWithPhases = arts.find(ar => ar.id === a.article_id);
        const phase = a.phase_id ? fullArtWithPhases?.phases?.find(p => p.id === a.phase_id) : null;
        if (a.verified) {
          // Confirmed assignment → green badge
          map[a.invoice_line_id] = {
            article_id: a.article_id, code: art?.code || '', name: art?.name || '',
            assigned_by: a.assigned_by, verified: a.verified, location: a.location,
            phase_id: a.phase_id || null, phase_code: phase?.code || null, phase_name: phase?.name || null,
          };
        } else {
          // AI suggestion from DB → orange badge
          const fullArt = arts.find(ar => ar.id === a.article_id);
          if (fullArt) {
            dbSuggestions[a.invoice_line_id] = {
              article: fullArt,
              confidence: Number(a.confidence) || 50,
              matchedKeywords: [],
              totalKeywords: fullArt.keywords.length,
              source: 'deterministic',
            };
          }
        }
      }
      setLineArticleMap(map);

      // Compute AI suggestions for lines with NO DB record at all
      // (runtime matching — learned rules first, then keyword fallback)
      if (detail?.invoice_lines && arts.length > 0) {
        const runtimeSuggestions: Record<string, MatchResult> = {};
        for (const line of detail.invoice_lines) {
          if (map[line.id]) continue;           // already confirmed
          if (dbSuggestions[line.id]) continue;  // already has DB suggestion
          const match = matchWithLearnedRules(line.description, arts, rules);
          if (match && match.confidence >= 70) {
            runtimeSuggestions[line.id] = match;
          }
        }
        // Merge: DB suggestions take priority, then runtime
        setAiSuggestions({ ...runtimeSuggestions, ...dbSuggestions });
      } else {
        setAiSuggestions(dbSuggestions);
      }
    })();

    return () => { cancelled = true; };
  }, [company?.id, invoice?.id, detail?.invoice_lines]);

  // Load classification data (categories, projects, accounts, invoice assignments)
  useEffect(() => {
    const companyId = company?.id;
    if (!companyId || !invoice?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const [cats, projs, accs, classif, iProjs, lineClf, lineProj] = await Promise.all([
          loadCategories(companyId, true),
          loadProjects(companyId, true),
          loadChartOfAccounts(companyId),
          loadInvoiceClassification(invoice.id),
          loadInvoiceProjects(invoice.id),
          loadLineClassifications(invoice.id),
          loadLineProjects(invoice.id),
        ]);
        if (cancelled) return;
        setAllCategories(cats);
        setAllProjects(projs);
        setAllAccounts(accs.filter(a => !a.is_header && a.active));
        setClassification(classif);
        setInvProjects(iProjs);
        setLineClassifs(lineClf);
        setLineProjects(lineProj);
        // Initialize local CdC rows from DB assignments
        setCdcRows(iProjs.map(ip => ({
          project_id: ip.project_id,
          percentage: Number(ip.percentage),
          amount: ip.amount ?? null,
        })));
        setSelCategoryId(classif?.category_id || null);
        setSelAccountId(classif?.account_id || null);
        setClassifDirty(false);
      } catch (e) { console.error('Classification load error:', e); }
    })();
    return () => { cancelled = true; };
  }, [company?.id, invoice?.id]);

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

      // Create classification rules from confirmed line-level data (fire-and-forget)
      const cp = (invoice.counterparty || {}) as any;
      if (detail?.invoice_lines) {
        for (const line of detail.invoice_lines) {
          const lc = lineClassifs[line.id];
          if (lc?.category_id || lc?.account_id) {
            createRuleFromConfirmation(
              companyId, cp?.piva || null, cp?.denom || null,
              line.description, invoice.direction as 'in' | 'out',
              { category_id: lc.category_id, account_id: lc.account_id,
                article_id: lineArticleMap[line.id]?.article_id || null },
            ).catch(err => console.warn('[rules] error:', err));
          }
        }
      }
    } catch (e: any) { console.error('Save classification error:', e); }
    setClassifSaving(false);
  }, [company?.id, invoice?.id, selCategoryId, selAccountId, cdcRows, cdcMode, detail?.invoice_lines, lineClassifs, lineArticleMap, invoice?.counterparty, invoice?.direction]);

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
  const handleLineClassifChange = useCallback(async (lineId: string, field: 'category_id' | 'account_id', value: string | null) => {
    // Optimistic update
    setLineClassifs(prev => ({
      ...prev,
      [lineId]: {
        ...prev[lineId],
        invoice_line_id: lineId,
        category_id: field === 'category_id' ? value : (prev[lineId]?.category_id ?? null),
        account_id: field === 'account_id' ? value : (prev[lineId]?.account_id ?? null),
      },
    }));
    try {
      const current = lineClassifs[lineId];
      await saveLineCategoryAndAccount(
        lineId,
        field === 'category_id' ? value : (current?.category_id ?? null),
        field === 'account_id' ? value : (current?.account_id ?? null),
      );
    } catch (e: any) { console.error('Save line classification error:', e); }
  }, [lineClassifs]);

  // AI classification — fast-path rules first, then unified Sonnet classifier
  const handleRequestAiClassification = useCallback(async () => {
    if (!invoice?.id || !company?.id) return;
    setAiClassifStatus('loading');
    try {
      const cp = (invoice.counterparty || {}) as any;
      const lines = detail?.invoice_lines || [];

      // Step 1: Fast-path — check classification rules (instant, 0ms)
      const ruleSuggestions = await findMatchingRules(
        company.id, cp?.piva || null, cp?.denom || null,
        lines.map(l => ({ id: l.id, description: l.description })),
        invoice.direction as 'in' | 'out',
      );

      const coveredLineIds = new Set(ruleSuggestions.map(s => s.line_id));
      const uncoveredLines = lines.filter(l => !coveredLineIds.has(l.id));

      // Step 2: For uncovered lines, call unified classifier (Sonnet)
      let aiResult: any = null;
      if (uncoveredLines.length > 0) {
        const token = await getValidAccessToken();
        const res = await fetch(`${SUPABASE_URL}/functions/v1/classify-invoice-lines`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'apikey': SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            company_id: company.id,
            invoice_id: invoice.id,
            lines: uncoveredLines.map(l => ({
              line_id: l.id,
              description: l.description,
              quantity: l.quantity,
              unit_price: l.unit_price,
              total_price: l.total_price,
            })),
            direction: invoice.direction,
            counterparty_vat_key: cp?.piva || null,
            counterparty_name: cp?.denom || null,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Errore AI');
        aiResult = data;
      }

      // Merge rule suggestions + AI result into the expected format
      const mergedLines = [
        ...ruleSuggestions.map(s => ({
          invoice_line_id: s.line_id,
          article_id: s.article_id,
          phase_id: null as string | null,
          category_id: s.category_id,
          account_id: s.account_id,
          project_allocations: s.cost_center_allocations || [],
          match_type: 'rule' as const,
          confidence: s.confidence,
          reasoning: 'Regola appresa',
        })),
        ...(aiResult?.lines || []).map((lr: any) => ({
          invoice_line_id: lr.line_id,
          article_id: lr.article_id || null,
          phase_id: lr.phase_id || null,
          category_id: lr.category_id,
          account_id: lr.account_id,
          project_allocations: lr.cost_center_allocations || [],
          match_type: 'ai' as const,
          confidence: lr.confidence,
          reasoning: lr.reasoning,
        })),
      ];

      const result = {
        invoice_id: invoice.id,
        lines: mergedLines,
        invoice_level: aiResult?.invoice_level || {
          category_id: ruleSuggestions[0]?.category_id || null,
          account_id: ruleSuggestions[0]?.account_id || null,
          project_allocations: [],
          confidence: ruleSuggestions[0]?.confidence || 0,
          reasoning: `${ruleSuggestions.length} righe da regole, ${aiResult?.lines?.length || 0} da AI`,
        },
      };

      setAiClassifResult(result);
      setAiClassifStatus('done');

      // Extract fiscal flags from AI results
      const flags: Record<string, any> = {};
      for (const lr of (aiResult?.lines || [])) {
        if (lr.fiscal_flags && lr.line_id) {
          flags[lr.line_id] = lr.fiscal_flags;
        }
      }
      setLineFiscalFlags(flags);

      // Extract AI suggestions for new accounts/categories
      const suggestions: Record<string, { suggest_new_account?: AccountSuggestion | null; suggest_new_category?: CategorySuggestion | null }> = {};
      for (const lr of (result.lines || [])) {
        const lid = lr.line_id || lr.invoice_line_id;
        if (lid && (lr.suggest_new_account || lr.suggest_new_category)) {
          suggestions[lid] = {
            suggest_new_account: lr.suggest_new_account || null,
            suggest_new_category: lr.suggest_new_category || null,
          };
        }
      }
      setLineSuggestions(suggestions);
      setDismissedSuggestions(new Set());

      // Reload classification data + article assignments to reflect persisted suggestions (incl. phase_id)
      const [classif, lineClf, lineProj, freshInvProjs, freshAssignments] = await Promise.all([
        loadInvoiceClassification(invoice.id),
        loadLineClassifications(invoice.id),
        loadLineProjects(invoice.id),
        loadInvoiceProjects(invoice.id),
        supabase.from('invoice_line_articles')
          .select('invoice_line_id, article_id, phase_id, assigned_by, verified, location, confidence, article:articles!inner(id, code, name, unit, keywords)')
          .eq('invoice_id', invoice.id).then(r => r.data || []),
      ]);

      // Rebuild lineArticleMap + aiSuggestions with fresh DB data (includes phase_id)
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
      setLineArticleMap(freshMap);
      setAiSuggestions(freshDbSugg);
      if (classif) {
        setClassification(classif);
        setSelCategoryId(classif.category_id || selCategoryId);
        setSelAccountId(classif.account_id || selAccountId);
      }
      setLineClassifs(lineClf);
      setLineProjects(lineProj);
      // Update CdC from DB-persisted invoice-level projects
      if (freshInvProjs.length > 0) {
        setInvProjects(freshInvProjs);
        setCdcRows(freshInvProjs.map(ip => ({
          project_id: ip.project_id,
          percentage: Number(ip.percentage),
          amount: ip.amount ?? null,
        })));
      } else if (result.invoice_level?.project_allocations?.length > 0) {
        // Fallback: use AI result directly if DB didn't persist yet
        const total = Math.abs(invoice.total_amount || 0);
        setCdcRows(result.invoice_level.project_allocations.map((pa: { project_id: string; percentage: number }) => ({
          project_id: pa.project_id,
          percentage: pa.percentage,
          amount: total > 0 ? Math.round(total * pa.percentage / 100 * 100) / 100 : null,
        })));
      }
    } catch (e: any) {
      console.error('AI classification error:', e);
      setAiClassifStatus('error');
    }
  }, [invoice?.id, company?.id, invoice?.counterparty, invoice?.direction, detail?.invoice_lines, selCategoryId, selAccountId]);

  // Confirm AI suggestion — set verified=true on invoice_classifications + line-level records
  const handleConfirmAiClassification = useCallback(async () => {
    if (!invoice?.id || !company?.id || !aiClassifResult) return;
    try {
      const il = aiClassifResult.invoice_level;
      // Save invoice-level as confirmed (verified=true)
      await saveInvoiceClassification(company.id, invoice.id, il.category_id, il.account_id);
      // Also confirm AI-suggested line-level article assignments (so deterministic matching learns from them)
      await supabase
        .from('invoice_line_articles')
        .update({ verified: true, assigned_by: 'manual' } as any)
        .eq('invoice_id', invoice.id)
        .eq('verified', false);
      const classif = await loadInvoiceClassification(invoice.id);
      setClassification(classif);
      setSelCategoryId(classif?.category_id || null);
      setSelAccountId(classif?.account_id || null);
      setAiClassifResult(null);
      setAiClassifStatus('idle');
      // Patch invoice in sidebar so ⚡ disappears (no full reload → preserves selection + scroll)
      onPatchInvoice(invoice.id, { classification_status: 'confirmed' } as Partial<DBInvoice>);

      // Reload article assignments so lineArticleMap reflects confirmed state (incl. phase_id)
      const { data: freshAssignments } = await supabase
        .from('invoice_line_articles')
        .select('invoice_line_id, article_id, phase_id, assigned_by, verified, location, confidence, article:articles!inner(id, code, name, unit, keywords)')
        .eq('invoice_id', invoice.id);
      const freshMap: Record<string, LineArticleInfo> = {};
      for (const a of (freshAssignments || [])) {
        const art = (a as any).article;
        const fullArtWithPhases = articles.find(ar => ar.id === a.article_id);
        const phase = a.phase_id ? fullArtWithPhases?.phases?.find(p => p.id === a.phase_id) : null;
        if (a.verified) {
          freshMap[a.invoice_line_id] = {
            article_id: a.article_id, code: art?.code || '', name: art?.name || '',
            assigned_by: a.assigned_by, verified: a.verified, location: a.location,
            phase_id: a.phase_id || null, phase_code: phase?.code || null, phase_name: phase?.name || null,
          };
        }
      }
      setLineArticleMap(freshMap);
      setAiSuggestions({});

      // Create classification rules from AI-confirmed lines (fire-and-forget)
      const cp = (invoice.counterparty || {}) as any;
      if (aiClassifResult.lines) {
        for (const lr of aiClassifResult.lines) {
          const lineDesc = detail?.invoice_lines?.find(l => l.id === lr.invoice_line_id)?.description;
          if (lineDesc && (lr.category_id || lr.account_id)) {
            createRuleFromConfirmation(
              company.id, cp?.piva || null, cp?.denom || null,
              lineDesc, invoice.direction as 'in' | 'out',
              { category_id: lr.category_id, account_id: lr.account_id, article_id: lr.article_id },
            ).catch(err => console.warn('[rules] error:', err));
          }
        }
      }
    } catch (e: any) { console.error('Confirm AI classification error:', e); }
  }, [invoice?.id, company?.id, aiClassifResult, articles, onPatchInvoice, detail?.invoice_lines, invoice?.counterparty, invoice?.direction]);

  // Reject AI suggestion — delete classification + reset status to 'none'
  const handleRejectAiClassification = useCallback(async () => {
    if (!invoice?.id) return;
    try {
      await deleteInvoiceClassification(invoice.id);
      await supabase.from('invoices').update({ classification_status: 'none' } as any).eq('id', invoice.id);
      setClassification(null);
      setSelCategoryId(null);
      setSelAccountId(null);
      setCdcRows([]);
      setClassifDirty(false);
      // Patch invoice in sidebar (no full reload → preserves selection + scroll)
      onPatchInvoice(invoice.id, { classification_status: 'none' } as Partial<DBInvoice>);
    } catch (e: any) { console.error('Reject AI classification error:', e); }
  }, [invoice?.id, onPatchInvoice]);

  // Confirm existing AI-suggested classification (from banner, not from inline AI trigger)
  const handleConfirmExistingClassification = useCallback(async () => {
    if (!invoice?.id || !company?.id) return;
    try {
      // Just mark as confirmed — the classification data already exists
      await supabase.from('invoice_classifications').update({ verified: true, assigned_by: 'manual', updated_at: new Date().toISOString() }).eq('invoice_id', invoice.id);
      await supabase.from('invoices').update({ classification_status: 'confirmed' } as any).eq('id', invoice.id);
      const classif = await loadInvoiceClassification(invoice.id);
      setClassification(classif);
      // Patch invoice in sidebar (no full reload → preserves selection + scroll)
      onPatchInvoice(invoice.id, { classification_status: 'confirmed' } as Partial<DBInvoice>);

      // Create classification rules from confirmed line data (fire-and-forget)
      const cp = (invoice.counterparty || {}) as any;
      if (detail?.invoice_lines) {
        for (const line of detail.invoice_lines) {
          const lc = lineClassifs[line.id];
          if (lc?.category_id || lc?.account_id) {
            createRuleFromConfirmation(
              company.id, cp?.piva || null, cp?.denom || null,
              line.description, invoice.direction as 'in' | 'out',
              { category_id: lc.category_id, account_id: lc.account_id,
                article_id: lineArticleMap[line.id]?.article_id || null },
            ).catch(err => console.warn('[rules] error:', err));
          }
        }
      }
    } catch (e: any) { console.error('Confirm existing classification error:', e); }
  }, [invoice?.id, company?.id, onPatchInvoice, detail?.invoice_lines, lineClassifs, lineArticleMap, invoice?.counterparty, invoice?.direction]);

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
        const [lineClf, freshCats, freshAccs] = await Promise.all([
          loadLineClassifications(invoice!.id),
          loadCategories(companyId, true),
          loadChartOfAccounts(companyId),
        ]);
        setLineClassifs(lineClf);
        setAllCategories(freshCats);
        setAllAccounts(freshAccs.filter(a => !a.is_header && a.active));
      }

      // Dismiss this suggestion
      setDismissedSuggestions(prev => new Set([...prev, lineId]));
    } catch (err: any) {
      toast.error(`Errore: ${err.message}`);
    }
    setCreatingSuggestion(null);
  }, [company?.id, invoice?.id, lineSuggestions, lineClassifs]);

  // Handle "Ignora" for AI-suggested new account/category
  const handleDismissSuggestion = useCallback((lineId: string) => {
    setDismissedSuggestions(prev => new Set([...prev, lineId]));
  }, []);

  const handleAssignArticle = useCallback(async (lineId: string, articleId: string, lineDesc: string, lineData: { quantity: number; unit_price: number; total_price: number; vat_rate: number }) => {
    const companyId = company?.id;
    if (!companyId || !invoice?.id) return;
    const location = extractLocation(lineDesc);
    const art = articles.find(a => a.id === articleId);
    const hasPhases = (art as ArticleWithPhases)?.phases?.length > 0;

    // Optimistic update BEFORE the network call — badge appears instantly
    const prevMap = { ...lineArticleMap };
    const prevSuggestions = { ...aiSuggestions };
    setLineArticleMap(prev => ({
      ...prev,
      [lineId]: {
        article_id: articleId, code: art?.code || '', name: art?.name || '',
        assigned_by: 'manual', verified: true, location,
        phase_id: null, phase_code: null, phase_name: null,
      },
    }));
    setAiSuggestions(prev => { const n = { ...prev }; delete n[lineId]; return n; });

    try {
      // upsert handles both INSERT and UPDATE via onConflict: 'invoice_line_id'
      // For multi-step articles, phase_id will be set later via handleAssignPhase
      await assignArticleToLine(companyId, lineId, invoice.id, articleId, lineData, 'manual', undefined, location, null);
      // Record feedback for manual assignment → creates a learned rule
      if (lineDesc && !hasPhases) {
        recordAssignmentFeedback(companyId, articleId, lineDesc, true).catch(err =>
          console.warn('Feedback record error:', err)
        );
      }
    } catch (err: any) {
      console.error('Article assign error:', err);
      // Revert optimistic update on failure
      setLineArticleMap(prevMap);
      setAiSuggestions(prevSuggestions);
    }
  }, [company?.id, invoice?.id, articles, lineArticleMap, aiSuggestions]);

  // Assign a phase to a line that already has an article
  const handleAssignPhase = useCallback(async (lineId: string, phaseId: string | null) => {
    const companyId = company?.id;
    if (!companyId || !invoice?.id) return;
    const info = lineArticleMap[lineId];
    if (!info) return;
    const art = articles.find(a => a.id === info.article_id) as ArticleWithPhases | undefined;
    const phase = phaseId ? art?.phases?.find(p => p.id === phaseId) : null;

    // Optimistic update
    const prevMap = { ...lineArticleMap };
    setLineArticleMap(prev => ({
      ...prev,
      [lineId]: {
        ...prev[lineId],
        phase_id: phaseId,
        phase_code: phase?.code || null,
        phase_name: phase?.name || null,
      },
    }));

    try {
      // Re-upsert with updated phase_id
      const dbLine = detail?.invoice_lines?.find(dl => dl.id === lineId);
      await assignArticleToLine(
        companyId, lineId, invoice.id, info.article_id,
        { quantity: dbLine?.quantity, unit_price: dbLine?.unit_price, total_price: dbLine?.total_price, vat_rate: dbLine?.vat_rate },
        'manual', undefined, info.location, phaseId,
      );
      // Record feedback with phase for learned rules
      if (dbLine?.description && phaseId) {
        recordAssignmentFeedback(companyId, info.article_id, dbLine.description, true, phaseId).catch(err =>
          console.warn('Feedback record error:', err)
        );
      }
    } catch (err: any) {
      console.error('Phase assign error:', err);
      setLineArticleMap(prevMap);
    }
  }, [company?.id, invoice?.id, articles, lineArticleMap, detail?.invoice_lines]);

  const handleRemoveArticle = useCallback(async (lineId: string) => {
    // Optimistic update BEFORE the network call
    const prevMap = { ...lineArticleMap };
    setLineArticleMap(prev => { const n = { ...prev }; delete n[lineId]; return n; });

    try {
      await removeLineAssignment(lineId);
    } catch (err: any) {
      console.error('Article remove error:', err);
      // Revert optimistic update on failure
      setLineArticleMap(prevMap);
    }
  }, [lineArticleMap]);

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

    // Optimistic update
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

    try {
      await Promise.all(lines.map(l =>
        assignArticleToLine(companyId, l.id, invoice.id, bulkArticleId,
          { quantity: l.quantity, unit_price: l.unit_price, total_price: l.total_price, vat_rate: l.vat_rate },
          'manual', undefined, location, bulkPhaseId,
        )
      ));
      toast.success(`Articolo ${art?.code} assegnato a ${lines.length} righe`);
    } catch (err: any) {
      console.error('Bulk article assign error:', err);
      setLineArticleMap(prevMap);
      toast.error('Errore assegnazione bulk');
    }
  }, [company?.id, invoice?.id, bulkArticleId, bulkPhaseId, articles, detail?.invoice_lines, lineArticleMap]);

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
  const classifNeedsAttention = invoice.classification_status === 'ai_suggested' || (!classification && aiClassifStatus === 'idle');

  if (loadingDetail) return <div className="text-center py-16 text-gray-400">Caricamento dettaglio...</div>;

  const nc = invoice.doc_type === 'TD04' || invoice.doc_type === 'TD05';
  const d = parsed;
  const b = d?.bodies?.[0];
  const cp = (invoice.counterparty || {}) as any;
  const cpStatus = String(invoice.counterparty_status_snapshot || '').toLowerCase();
  const showCounterpartyAlert = cpStatus === 'pending' || cpStatus === 'rejected' || !invoice.counterparty_id;
  const hasRefs = b?.contratti?.length > 0 || b?.ordini?.length > 0 || b?.convenzioni?.length > 0;
  const lineCount = b?.linee?.length || detail?.invoice_lines?.length || 0;
  const classifiedLineCount = Object.keys(lineClassifs).filter(lid => lineClassifs[lid]?.category_id || lineClassifs[lid]?.account_id).length;

  return (
    <div className="flex flex-col h-full" id="invoice-detail-print">
      {/* HEADER STRIP */}
      <div className="px-4 pt-3 pb-2 bg-white border-b flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={onNavigateCounterparty}
              className="text-base font-bold text-blue-700 hover:text-blue-900 hover:underline cursor-pointer truncate max-w-[280px] bg-transparent border-none p-0 text-left"
              title="Vai alla controparte"
            >
              {cp?.denom || invoice.source_filename || 'Sconosciuto'}
            </button>
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md ${STATUS_COLORS[invoice.payment_status] || 'bg-gray-100 text-gray-600'}`}>
              {STATUS_LABELS[invoice.payment_status] || invoice.payment_status}
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
        <div className="text-xs text-gray-500 mt-0.5">
          N. {invoice.number} {'\u2014'} {fmtDate(invoice.date)} {'\u2014'} <span className="font-bold text-gray-700">{fmtEur(invoice.total_amount)}</span>
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

        {/* ═══ TAB: CLASSIFICAZIONE ═══ */}
        {activeTab === 'classificazione' && (
          <div className="p-4 space-y-4">
            {/* Apply to all rows section */}
            {(allCategories.length > 0 || allAccounts.length > 0 || allProjects.length > 0) && (
              <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-xl p-4">
                <div className="flex items-center justify-between mb-1">
                  <div>
                    <h3 className="text-sm font-bold text-gray-800">Applica a tutte le righe</h3>
                    <p className="text-[11px] text-gray-500">Scegli qui per compilare tutte le righe in blocco. Puoi poi modificarle singolarmente.</p>
                  </div>
                  {/* AI Suggest button */}
                  {aiClassifStatus === 'idle' && !aiClassifResult && (
                    <button onClick={handleRequestAiClassification}
                      className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold rounded-lg bg-gradient-to-r from-purple-600 to-indigo-600 text-white hover:from-purple-700 hover:to-indigo-700 shadow-md transition-all">
                      <span>{'\u2728'}</span> Suggerisci AI
                    </button>
                  )}
                  {aiClassifStatus === 'loading' && (
                    <div className="flex items-center gap-2 text-xs text-purple-600">
                      <span className="animate-spin">{'\u21BB'}</span> Classificazione AI...
                    </div>
                  )}
                </div>

                {/* AI Suggestion Banner */}
                {invoice.classification_status === 'ai_suggested' && (
                  <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
                    <span className="text-amber-500 text-sm flex-shrink-0">{'\u26A1'}</span>
                    <span className="text-xs text-amber-800 flex-1">Classificazione suggerita dall'AI {'\u2014'} verifica e conferma</span>
                    <button onClick={handleConfirmExistingClassification}
                      className="px-2.5 py-1 text-[11px] font-semibold rounded-md bg-emerald-600 text-white hover:bg-emerald-700 flex-shrink-0">
                      {'\u2713'} Conferma
                    </button>
                    <button onClick={handleRejectAiClassification}
                      className="px-2.5 py-1 text-[11px] font-semibold rounded-md bg-red-100 text-red-700 hover:bg-red-200 flex-shrink-0">
                      {'\u2715'} Rifiuta
                    </button>
                  </div>
                )}

                {/* AI result panel */}
                {aiClassifResult && !classification?.verified && (
                  <div className="bg-purple-50 border border-purple-200 rounded-lg px-3 py-2 mb-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-purple-600 text-sm">{'\u2728'}</span>
                      <span className="text-xs font-semibold text-purple-800">Suggerimento AI</span>
                      <span className="text-[10px] text-purple-500 ml-auto">
                        Confidenza: {aiClassifResult.invoice_level?.confidence ?? 0}%
                      </span>
                    </div>
                    {aiClassifResult.invoice_level?.reasoning && (
                      <p className="text-[10px] text-purple-700 mb-2">{aiClassifResult.invoice_level.reasoning}</p>
                    )}
                    <div className="flex gap-2">
                      <button onClick={handleConfirmAiClassification}
                        className="px-2.5 py-1 text-xs font-semibold rounded bg-emerald-600 text-white hover:bg-emerald-700">
                        Conferma
                      </button>
                      <button onClick={() => { setAiClassifResult(null); setAiClassifStatus('idle'); }}
                        className="px-2.5 py-1 text-xs font-semibold rounded bg-gray-200 text-gray-700 hover:bg-gray-300">
                        Ignora
                      </button>
                    </div>
                  </div>
                )}

                {aiClassifStatus === 'error' && (
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-xs text-red-600">Errore classificazione AI</span>
                    <button onClick={() => setAiClassifStatus('idle')} className="text-xs text-sky-600 hover:underline">Riprova</button>
                  </div>
                )}

                {/* Three dropdowns: Categoria | Piano conti | Centro di costo */}
                <div className="grid grid-cols-3 gap-3 mt-3">
                  <div>
                    <label className="block text-[10px] font-medium text-gray-500 mb-1">Categoria</label>
                    <select
                      value={selCategoryId || ''}
                      onChange={e => { setSelCategoryId(e.target.value || null); setClassifDirty(true); }}
                      className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded-lg bg-white focus:ring-2 focus:ring-blue-400 outline-none">
                      <option value="">{'\u2014'} Nessuna {'\u2014'}</option>
                      {allCategories.map(c => (
                        <option key={c.id} value={c.id}>{c.name} ({CATEGORY_TYPE_LABELS[c.type]})</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-medium text-gray-500 mb-1">Piano conti</label>
                    <select
                      value={selAccountId || ''}
                      onChange={e => { setSelAccountId(e.target.value || null); setClassifDirty(true); }}
                      className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded-lg bg-white focus:ring-2 focus:ring-blue-400 outline-none">
                      <option value="">{'\u2014'} Nessuno {'\u2014'}</option>
                      {allAccounts.map(a => (
                        <option key={a.id} value={a.id}>{a.code} {'\u2014'} {a.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-medium text-gray-500 mb-1">Centro di costo</label>
                    <select
                      value={cdcRows.length === 1 ? cdcRows[0].project_id : ''}
                      onChange={e => {
                        const val = e.target.value;
                        if (val) {
                          const total = Math.abs(invoice?.total_amount || 0);
                          setCdcRows([{ project_id: val, percentage: 100, amount: total > 0 ? total : null }]);
                        } else {
                          setCdcRows([]);
                        }
                        setClassifDirty(true);
                      }}
                      className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded-lg bg-white focus:ring-2 focus:ring-blue-400 outline-none">
                      <option value="">{'\u2014'} Nessuno {'\u2014'}</option>
                      {allProjects.map(p => (
                        <option key={p.id} value={p.id}>{p.code} {'\u2014'} {p.name}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Bulk article + phase assignment */}
                {articles.length > 0 && (
                  <div className="flex items-end gap-2 mt-3">
                    <div className="flex-1">
                      <label className="block text-[10px] font-medium text-gray-500 mb-1">Articolo (tutte le righe)</label>
                      <select
                        value={bulkArticleId || ''}
                        onChange={e => { setBulkArticleId(e.target.value || null); setBulkPhaseId(null); }}
                        className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded-lg bg-white focus:ring-2 focus:ring-blue-400 outline-none">
                        <option value="">{'\u2014'} Nessuno {'\u2014'}</option>
                        {articles.map(a => (
                          <option key={a.id} value={a.id}>{a.code} {'\u2014'} {a.name}</option>
                        ))}
                      </select>
                    </div>
                    {/* Cascading phase dropdown — only when bulk article has phases */}
                    {(() => {
                      const bulkArt = bulkArticleId ? articles.find(a => a.id === bulkArticleId) : null;
                      if (!bulkArt?.phases?.length) return null;
                      const sorted = [...bulkArt.phases].sort((a, b) => a.sort_order - b.sort_order);
                      return (
                        <div className="flex-1">
                          <label className="block text-[10px] font-medium text-gray-500 mb-1">Fase</label>
                          <select
                            value={bulkPhaseId || ''}
                            onChange={e => setBulkPhaseId(e.target.value || null)}
                            className={`w-full px-2 py-1.5 text-xs border rounded-lg bg-white focus:ring-2 focus:ring-blue-400 outline-none ${
                              !bulkPhaseId ? 'border-orange-300 bg-orange-50' : 'border-gray-200'
                            }`}>
                            <option value="">{'\u2014'} Seleziona fase {'\u2014'}</option>
                            {sorted.map(p => (
                              <option key={p.id} value={p.id}>
                                {p.is_counting_point ? '\u25CF ' : ''}{p.code} {'\u2014'} {p.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      );
                    })()}
                    <button
                      onClick={handleBulkAssignArticle}
                      disabled={!bulkArticleId || (articles.find(a => a.id === bulkArticleId)?.phases?.length ? !bulkPhaseId : false)}
                      className="px-3 py-1.5 text-xs font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-40 transition-colors whitespace-nowrap"
                      title={bulkArticleId && articles.find(a => a.id === bulkArticleId)?.phases?.length && !bulkPhaseId ? 'Seleziona la fase per questo articolo' : ''}>
                      Applica articolo
                    </button>
                  </div>
                )}

                {/* Save button for template */}
                {classifDirty && (
                  <div className="flex justify-end pt-2">
                    <button onClick={handleSaveClassification} disabled={classifSaving || !cdcValidation.valid}
                      className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                      title={!cdcValidation.valid ? cdcValidation.message : ''}>
                      {classifSaving ? 'Salvataggio...' : 'Salva classificazione'}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Invoice lines table with classification */}
            <div className="bg-white border rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b bg-gray-50">
                <h3 className="text-sm font-bold text-gray-800">Righe fattura</h3>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-emerald-600 font-medium">{lineCount} righe</span>
                  <span className="text-[11px] text-gray-400">{classifiedLineCount}/{lineCount} classificate</span>
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
                    {allCategories.length > 0 && <th className="text-center px-1 py-2 text-gray-600 font-semibold w-24">Categoria</th>}
                    {allProjects.length > 0 && <th className="text-center px-1 py-2 text-gray-600 font-semibold w-20">CdC</th>}
                    {allAccounts.length > 0 && <th className="text-center px-1 py-2 text-gray-600 font-semibold w-20">Conto</th>}
                  </tr></thead>
                  <tbody>
                    {(b?.linee || []).map((l: any, i: number) => {
                      const dbLine = detail?.invoice_lines?.find(dl => dl.line_number === parseInt(l.numero || String(i + 1)));
                      const lineId = dbLine?.id;
                      const lineCat = lineId ? lineClassifs[lineId]?.category_id : null;
                      const lineAcc = lineId ? lineClassifs[lineId]?.account_id : null;
                      const ff = lineId ? lineFiscalFlags[lineId] : null;
                      const hasFiscalFlags = ff && (ff.ritenuta_acconto || ff.reverse_charge || ff.split_payment || ff.bene_strumentale || (ff.deducibilita_pct != null && ff.deducibilita_pct < 100) || (ff.iva_detraibilita_pct != null && ff.iva_detraibilita_pct < 100));
                      const colCount = 5 + (allCategories.length > 0 ? 1 : 0) + (allProjects.length > 0 ? 1 : 0) + (allAccounts.length > 0 ? 1 : 0);
                      return (
                      <React.Fragment key={i}>
                      <tr className="border-b border-gray-50 hover:bg-gray-50/50">
                        <td className="text-left px-3 py-2 max-w-[200px]">
                          <span className="text-gray-800">{l.descrizione}</span>
                          {/* Article badge + phase dropdown inline */}
                          {lineId && articles.length > 0 && (
                            <span className="ml-1.5 inline-flex items-center gap-1 align-middle flex-wrap">
                              <ArticleDropdown
                                articles={articles}
                                current={lineArticleMap[lineId] || null}
                                suggestion={aiSuggestions[lineId] || null}
                                onAssign={(artId) => handleAssignArticle(lineId, artId, l.descrizione || '', {
                                  quantity: safeFloat(l.quantita) || 1, unit_price: safeFloat(l.prezzoUnitario),
                                  total_price: safeFloat(l.prezzoTotale), vat_rate: safeFloat(l.aliquotaIVA),
                                })}
                                onRemove={() => handleRemoveArticle(lineId)}
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
                        <td className="text-right px-2 py-2 text-gray-600">{l.quantita ? fmtNum(safeFloat(l.quantita)) : '1'}</td>
                        <td className="text-right px-2 py-2 text-gray-600">{fmtNum(safeFloat(l.prezzoUnitario))}</td>
                        <td className="text-right px-2 py-2 text-gray-600">{fmtNum(safeFloat(l.aliquotaIVA))}%</td>
                        <td className="text-right px-2 py-2 font-bold text-gray-800">{fmtNum(safeFloat(l.prezzoTotale))}</td>
                        {allCategories.length > 0 && <td className="text-center px-1 py-1">
                          {lineId ? (
                            <select
                              value={lineCat || ''}
                              onChange={e => handleLineClassifChange(lineId, 'category_id', e.target.value || null)}
                              className={`w-full px-1 py-1 text-[10px] border rounded-md outline-none cursor-pointer ${lineCat ? 'bg-blue-50 border-blue-200 text-blue-700 font-semibold' : 'border-gray-200 bg-white text-gray-500'}`}
                            >
                              <option value="">{selCategoryId ? '\u2190 Fatt.' : '\u2014'}</option>
                              {allCategories.map(c => <option key={c.id} value={c.id}>{c.name.substring(0, 14)}</option>)}
                            </select>
                          ) : <span className="text-[9px] text-gray-300">{'\u2014'}</span>}
                        </td>}
                        {allProjects.length > 0 && <td className="text-center px-1 py-1 relative">
                          {lineId ? (
                            <>
                              <button
                                onClick={() => setCdcPopoverLineId(cdcPopoverLineId === lineId ? null : lineId)}
                                className={`text-[10px] hover:underline cursor-pointer w-full text-center px-1 py-1 rounded-md border ${
                                  lineProjects[lineId]?.length ? 'bg-indigo-50 border-indigo-200 text-indigo-700 font-semibold' : 'border-gray-200 text-gray-500'
                                }`}
                              >
                                {lineProjects[lineId]?.length
                                  ? lineProjects[lineId].map(lp => allProjects.find(p => p.id === lp.project_id)?.code).filter(Boolean).join(', ').substring(0, 12)
                                  : (cdcRows.length > 0 ? '\u2190 Fatt.' : '\u2014')
                                }
                              </button>
                              {cdcPopoverLineId === lineId && (
                                <div className="absolute z-50 top-full right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-xl p-3 w-64" onClick={e => e.stopPropagation()}>
                                  <div className="flex items-center justify-between mb-2">
                                    <span className="text-[10px] font-semibold text-gray-700">CdC Riga</span>
                                    <button onClick={() => setCdcPopoverLineId(null)} className="text-gray-400 hover:text-gray-600 text-xs">x</button>
                                  </div>
                                  {(lineProjects[lineId] || []).map((lp, lpIdx) => {
                                    const proj = allProjects.find(p => p.id === lp.project_id);
                                    return (
                                      <div key={lp.id || lpIdx} className="flex items-center gap-1 mb-1">
                                        <span className="text-[9px] text-gray-600 flex-1 truncate">{proj?.code} {proj?.name}</span>
                                        <input type="number" min={0} max={100} step={1}
                                          value={lp.percentage}
                                          onChange={e => {
                                            const pct = Math.max(0, Math.min(100, Number(e.target.value)));
                                            setLineProjects(prev => ({
                                              ...prev,
                                              [lineId]: (prev[lineId] || []).map((r, ri) => ri === lpIdx ? { ...r, percentage: pct } : r),
                                            }));
                                          }}
                                          className="w-12 text-[9px] text-right border rounded px-1 py-0.5"
                                        />
                                        <span className="text-[9px] text-gray-400">%</span>
                                        <button onClick={() => {
                                          setLineProjects(prev => ({
                                            ...prev,
                                            [lineId]: (prev[lineId] || []).filter((_, ri) => ri !== lpIdx),
                                          }));
                                        }} className="text-red-400 hover:text-red-600 text-[9px]">x</button>
                                      </div>
                                    );
                                  })}
                                  <div className="flex items-center gap-1 mt-1">
                                    <select className="flex-1 text-[9px] border rounded px-1 py-0.5" value=""
                                      onChange={e => {
                                        if (!e.target.value) return;
                                        setLineProjects(prev => ({
                                          ...prev,
                                          [lineId]: [...(prev[lineId] || []), { id: crypto.randomUUID(), invoice_line_id: lineId, project_id: e.target.value, percentage: 100, amount: null }],
                                        }));
                                      }}
                                    >
                                      <option value="">+ Aggiungi CdC</option>
                                      {allProjects.filter(p => !(lineProjects[lineId] || []).some(lp => lp.project_id === p.id)).map(p => (
                                        <option key={p.id} value={p.id}>{p.code} - {p.name}</option>
                                      ))}
                                    </select>
                                  </div>
                                  <button
                                    onClick={async () => {
                                      if (!company?.id || !invoice?.id) return;
                                      try {
                                        const toSave = (lineProjects[lineId] || []).map(lp => ({
                                          project_id: lp.project_id, percentage: lp.percentage, amount: lp.amount,
                                        }));
                                        await saveLineProjects(company.id, invoice.id, lineId, toSave);
                                        const fresh = await loadLineProjects(invoice.id);
                                        setLineProjects(fresh);
                                        setCdcPopoverLineId(null);
                                      } catch (e: any) { console.error('Save line CdC error:', e); }
                                    }}
                                    className="mt-2 w-full text-[10px] font-semibold bg-sky-600 text-white rounded px-2 py-1 hover:bg-sky-700"
                                  >
                                    Salva
                                  </button>
                                </div>
                              )}
                            </>
                          ) : <span className="text-[9px] text-gray-300">{'\u2014'}</span>}
                        </td>}
                        {allAccounts.length > 0 && <td className="text-center px-1 py-1">
                          {lineId ? (
                            <select
                              value={lineAcc || ''}
                              onChange={e => handleLineClassifChange(lineId, 'account_id', e.target.value || null)}
                              className={`w-full px-1 py-1 text-[10px] border rounded-md outline-none cursor-pointer ${lineAcc ? 'bg-emerald-50 border-emerald-200 text-emerald-700 font-semibold' : 'border-gray-200 bg-white text-gray-500'}`}
                            >
                              <option value="">{selAccountId ? '\u2190 Fatt.' : '\u2014'}</option>
                              {allAccounts.map(a => <option key={a.id} value={a.id}>{a.code}</option>)}
                            </select>
                          ) : <span className="text-[9px] text-gray-300">{'\u2014'}</span>}
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
                    {!b?.linee?.length && detail?.invoice_lines?.map((l, i) => {
                      const lineCat = lineClassifs[l.id]?.category_id;
                      const lineAcc = lineClassifs[l.id]?.account_id;
                      const ff2 = lineFiscalFlags[l.id];
                      const hasFf2 = ff2 && (ff2.ritenuta_acconto || ff2.reverse_charge || ff2.split_payment || ff2.bene_strumentale || (ff2.deducibilita_pct != null && ff2.deducibilita_pct < 100) || (ff2.iva_detraibilita_pct != null && ff2.iva_detraibilita_pct < 100));
                      const colCount2 = 5 + (allCategories.length > 0 ? 1 : 0) + (allProjects.length > 0 ? 1 : 0) + (allAccounts.length > 0 ? 1 : 0);
                      return (
                      <React.Fragment key={i}>
                      <tr className="border-b border-gray-50 hover:bg-gray-50/50">
                        <td className="text-left px-3 py-2">
                          <span className="text-gray-800">{l.description}</span>
                          {articles.length > 0 && (
                            <span className="ml-1.5 inline-flex items-center gap-1 align-middle flex-wrap">
                              <ArticleDropdown articles={articles} current={lineArticleMap[l.id] || null} suggestion={aiSuggestions[l.id] || null}
                                onAssign={(artId) => handleAssignArticle(l.id, artId, l.description, { quantity: l.quantity, unit_price: l.unit_price, total_price: l.total_price, vat_rate: l.vat_rate })}
                                onRemove={() => handleRemoveArticle(l.id)} />
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
                        <td className="text-right px-2 py-2 text-gray-600">{fmtNum(l.quantity)}</td>
                        <td className="text-right px-2 py-2 text-gray-600">{fmtNum(l.unit_price)}</td>
                        <td className="text-right px-2 py-2 text-gray-600">{fmtNum(l.vat_rate)}%</td>
                        <td className="text-right px-2 py-2 font-bold text-gray-800">{fmtNum(l.total_price)}</td>
                        {allCategories.length > 0 && <td className="text-center px-1 py-1">
                          <select value={lineCat || ''} onChange={e => handleLineClassifChange(l.id, 'category_id', e.target.value || null)}
                            className={`w-full px-1 py-1 text-[10px] border rounded-md outline-none cursor-pointer ${lineCat ? 'bg-blue-50 border-blue-200 text-blue-700 font-semibold' : 'border-gray-200 bg-white text-gray-500'}`}>
                            <option value="">{selCategoryId ? '\u2190 Fatt.' : '\u2014'}</option>
                            {allCategories.map(c => <option key={c.id} value={c.id}>{c.name.substring(0, 14)}</option>)}
                          </select>
                        </td>}
                        {allProjects.length > 0 && <td className="text-center px-1 py-1 relative">
                          <button onClick={() => setCdcPopoverLineId(cdcPopoverLineId === l.id ? null : l.id)}
                            className={`text-[10px] cursor-pointer w-full text-center px-1 py-1 rounded-md border ${lineProjects[l.id]?.length ? 'bg-indigo-50 border-indigo-200 text-indigo-700 font-semibold' : 'border-gray-200 text-gray-500'}`}>
                            {lineProjects[l.id]?.length ? lineProjects[l.id].map(lp => allProjects.find(p => p.id === lp.project_id)?.code).filter(Boolean).join(', ').substring(0, 12) : (cdcRows.length > 0 ? '\u2190 Fatt.' : '\u2014')}
                          </button>
                          {cdcPopoverLineId === l.id && (
                            <div className="absolute z-50 top-full right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-xl p-3 w-64" onClick={e => e.stopPropagation()}>
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-[10px] font-semibold text-gray-700">CdC Riga</span>
                                <button onClick={() => setCdcPopoverLineId(null)} className="text-gray-400 hover:text-gray-600 text-xs">x</button>
                              </div>
                              {(lineProjects[l.id] || []).map((lp, lpIdx) => {
                                const proj = allProjects.find(p => p.id === lp.project_id);
                                return (
                                  <div key={lp.id || lpIdx} className="flex items-center gap-1 mb-1">
                                    <span className="text-[9px] text-gray-600 flex-1 truncate">{proj?.code} {proj?.name}</span>
                                    <input type="number" min={0} max={100} step={1} value={lp.percentage}
                                      onChange={e => { const pct = Math.max(0, Math.min(100, Number(e.target.value))); setLineProjects(prev => ({ ...prev, [l.id]: (prev[l.id] || []).map((r, ri) => ri === lpIdx ? { ...r, percentage: pct } : r) })); }}
                                      className="w-12 text-[9px] text-right border rounded px-1 py-0.5" />
                                    <span className="text-[9px] text-gray-400">%</span>
                                    <button onClick={() => { setLineProjects(prev => ({ ...prev, [l.id]: (prev[l.id] || []).filter((_, ri) => ri !== lpIdx) })); }} className="text-red-400 hover:text-red-600 text-[9px]">x</button>
                                  </div>
                                );
                              })}
                              <div className="flex items-center gap-1 mt-1">
                                <select className="flex-1 text-[9px] border rounded px-1 py-0.5" value=""
                                  onChange={e => { if (!e.target.value) return; setLineProjects(prev => ({ ...prev, [l.id]: [...(prev[l.id] || []), { id: crypto.randomUUID(), invoice_line_id: l.id, project_id: e.target.value, percentage: 100, amount: null }] })); }}>
                                  <option value="">+ Aggiungi CdC</option>
                                  {allProjects.filter(p => !(lineProjects[l.id] || []).some(lp => lp.project_id === p.id)).map(p => (
                                    <option key={p.id} value={p.id}>{p.code} - {p.name}</option>
                                  ))}
                                </select>
                              </div>
                              <button onClick={async () => {
                                if (!company?.id || !invoice?.id) return;
                                try {
                                  const toSave = (lineProjects[l.id] || []).map(lp => ({ project_id: lp.project_id, percentage: lp.percentage, amount: lp.amount }));
                                  await saveLineProjects(company.id, invoice.id, l.id, toSave);
                                  const fresh = await loadLineProjects(invoice.id);
                                  setLineProjects(fresh);
                                  setCdcPopoverLineId(null);
                                } catch (e: any) { console.error('Save line CdC error:', e); }
                              }} className="mt-2 w-full text-[10px] font-semibold bg-sky-600 text-white rounded px-2 py-1 hover:bg-sky-700">Salva</button>
                            </div>
                          )}
                        </td>}
                        {allAccounts.length > 0 && <td className="text-center px-1 py-1">
                          <select value={lineAcc || ''} onChange={e => handleLineClassifChange(l.id, 'account_id', e.target.value || null)}
                            className={`w-full px-1 py-1 text-[10px] border rounded-md outline-none cursor-pointer ${lineAcc ? 'bg-emerald-50 border-emerald-200 text-emerald-700 font-semibold' : 'border-gray-200 bg-white text-gray-500'}`}>
                            <option value="">{selAccountId ? '\u2190 Fatt.' : '\u2014'}</option>
                            {allAccounts.map(a => <option key={a.id} value={a.id}>{a.code}</option>)}
                          </select>
                        </td>}
                      </tr>
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
                    })}
                  </tbody>
                </table>
              </div>
              {/* Footer */}
              <div className="flex items-center justify-between px-4 py-2.5 border-t bg-gray-50">
                <span className="text-[11px] text-gray-400">Classificazione salvata automaticamente per riga</span>
                <div className="flex items-center gap-2">
                  <button onClick={handleConfirmExistingClassification} disabled={invoice.classification_status !== 'ai_suggested'}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                    {'\u2713'} Conferma tutte
                  </button>
                  <button onClick={handleRejectAiClassification} disabled={invoice.classification_status !== 'ai_suggested'}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                    Ignora suggerimenti
                  </button>
                </div>
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
      </div>
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
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const companyId = company?.id || null;
  const { matchedInvoiceIds, invoiceScores, refresh: refreshBadges } = useReconciliationBadges();
  const { setEntity: setPageEntity } = usePageEntity();
  const [invoices, setInvoices] = useState<DBInvoice[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DBInvoiceDetail | null>(null);
  const [installments, setInstallments] = useState<InvoiceInstallment[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingList, setLoadingList] = useState(false);

  // Pagination
  const PAGE_SIZE = 50;
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(0);
  const [allLoaded, setAllLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [debouncedQuery, setDebouncedQuery] = useState('');
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
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'overdue' | 'paid'>('all');
  const [aiSuggestedFilter, setAiSuggestedFilter] = useState(false);
  const [directionFilter, setDirectionFilter] = useState<'all' | 'in' | 'out'>('in');
  const [selectMode, setSelectMode] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [deleteModal, setDeleteModal] = useState<{ open: boolean; ids: string[] }>({ open: false, ids: [] });

  // ── Date filter ──
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // ── Export dialog ──
  const [exportOpen, setExportOpen] = useState(false);

  // ── Classification metadata for sidebar icons ──
  const [classifMeta, setClassifMeta] = useState<Map<string, InvoiceClassificationMeta>>(new Map());

  // ── AI search (BancaPage-style: filter + analysis modes) ──
  const [aiResult, setAiResult] = useState<InvoiceAiResult | null>(null);
  const [aiSearching, setAiSearching] = useState(false);
  const [aiError, setAiError] = useState('');

  // ── AI filter state (structured filters from AI classification) ──
  const [amountMin, setAmountMin] = useState<number | undefined>(undefined);
  const [amountMax, setAmountMax] = useState<number | undefined>(undefined);
  const [counterpartyPattern, setCounterpartyPattern] = useState<string | undefined>(undefined);

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
      const token = await getValidAccessToken();
      let successCount = 0;
      let failedCount = 0;
      const classifiedIds: string[] = [];

      // Process 3 invoices in parallel
      const PARALLEL = 3;
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

              // Step 1: Fast-path rules (instant, no API call)
              const ruleSuggestions = await findMatchingRules(
                companyId, cp?.piva || null, cp?.denom || null,
                lines.map(l => ({ id: l.id, description: l.description })),
                inv.direction as 'in' | 'out',
              );

              // Apply rule suggestions to DB (fire-and-forget via supabase)
              for (const s of ruleSuggestions) {
                if (s.category_id || s.account_id) {
                  await supabase.from('invoice_lines').update({
                    category_id: s.category_id, account_id: s.account_id,
                    classification_status: 'ai_suggested',
                  } as any).eq('id', s.line_id).is('category_id', null);
                }
              }

              // Step 2: Uncovered lines → unified classifier
              const coveredIds = new Set(ruleSuggestions.map(s => s.line_id));
              const uncoveredLines = lines.filter(l => !coveredIds.has(l.id));

              if (uncoveredLines.length > 0) {
                const res = await fetch(`${SUPABASE_URL}/functions/v1/classify-invoice-lines`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                    'apikey': SUPABASE_ANON_KEY,
                  },
                  body: JSON.stringify({
                    company_id: companyId,
                    invoice_id: inv.id,
                    lines: uncoveredLines.map(l => ({
                      line_id: l.id,
                      description: l.description,
                      quantity: l.quantity,
                      unit_price: l.unit_price,
                      total_price: l.total_price,
                    })),
                    direction: inv.direction,
                    counterparty_vat_key: cp?.piva || null,
                    counterparty_name: cp?.denom || null,
                  }),
                  signal,
                });
                if (!res.ok) {
                  console.error(`Classification error for ${inv.id}: HTTP ${res.status}`);
                  return { ok: false };
                }
              } else if (ruleSuggestions.length > 0) {
                // All lines covered by rules — create invoice-level classification from rules
                const firstRule = ruleSuggestions[0];
                await supabase.from('invoice_classifications').upsert({
                  company_id: companyId, invoice_id: inv.id,
                  category_id: firstRule.category_id, account_id: firstRule.account_id,
                  assigned_by: 'ai_auto', verified: false,
                  ai_confidence: firstRule.confidence,
                  ai_reasoning: `${ruleSuggestions.length} righe da regole apprese`,
                } as any, { onConflict: 'invoice_id' });
              }

              return { ok: true };
            } catch (fetchErr: any) {
              if (fetchErr?.name === 'AbortError') throw fetchErr;
              console.error('Batch classification error:', fetchErr);
              return { ok: false };
            }
          }),
        );

        for (let j = 0; j < results.length; j++) {
          if (results[j].ok) {
            successCount++;
            classifiedIds.push(batch[j].id);
          } else {
            failedCount++;
          }
        }
        updateProgress(Math.min(i + PARALLEL, unclassified.length), unclassified.length);
      }

      // Mark classified invoices as ai_suggested (bulk, 200 per call)
      for (let i = 0; i < classifiedIds.length; i += 200) {
        const chunk = classifiedIds.slice(i, i + 200);
        await supabase.from('invoices').update({ classification_status: 'ai_suggested' } as any).in('id', chunk);
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
      const token = await getValidAccessToken();
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

        for (const inv of pending) {
          if (signal.aborted) break;
          const { data: lines } = await supabase
            .from('invoice_lines')
            .select('id, description, quantity, unit_price, total_price')
            .eq('invoice_id', inv.id);
          if (!lines || lines.length === 0) { totalProcessed++; continue; }
          const cp = inv.counterparty as Record<string, string> | null;
          await fetch(`${SUPABASE_URL}/functions/v1/classify-invoice-lines`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              company_id: companyId, invoice_id: inv.id,
              lines: lines.map(l => ({ line_id: l.id, description: l.description || '', quantity: l.quantity, unit_price: l.unit_price, total_price: l.total_price })),
              direction: inv.direction || 'in', counterparty_name: cp?.denom || '',
            }),
            signal,
          });
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
      const result = await loadInvoices(companyId, filters, { page: currentPage, pageSize: PAGE_SIZE });
      if (reset) {
        setInvoices(result.data);
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
        setInvoices(prev => [...prev, ...result.data]);
      }
      setTotalCount(result.count);
      if (result.data.length < PAGE_SIZE) setAllLoaded(true);
    } catch (e) { console.error('Errore:', e); }
    setLoadingList(false);
    setLoadingMore(false);
  }, [companyId, buildFilters, page]);

  // Initial load + reload when filters change
  useEffect(() => {
    if (!companyId) return;
    setPage(0); setAllLoaded(false); setInvoices([]); setTotalCount(0);
    reload(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, directionFilter, statusFilter, dateFrom, dateTo, debouncedQuery, aiResult?.candidateIds?.join(','), amountMin, amountMax, counterpartyPattern, aiSuggestedFilter, reloadTrigger]);

  // Load next page
  useEffect(() => { if (page > 0) reload(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [page]);

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
    if (!selectedId || !companyId) { setDetail(null); setInstallments([]); return; }
    let c = false; setLoadingDetail(true);
    Promise.all([
      loadInvoiceDetail(selectedId),
      listInstallmentsForInvoice(companyId, selectedId),
    ]).then(([d, inst]) => {
      if (!c) {
        setDetail(d);
        setInstallments(inst);
        setLoadingDetail(false);
      }
    }).catch(() => {
      if (!c) {
        setDetail(null);
        setInstallments([]);
        setLoadingDetail(false);
      }
    });
    return () => { c = true; };
  }, [selectedId, companyId]);

  useEffect(() => {
    const invoiceIdParam = searchParams.get('invoiceId');
    if (!invoiceIdParam || !companyId) return;

    // If already in current list, select it and clean up URL
    if (invoices.some(inv => inv.id === invoiceIdParam)) {
      setSelectedId(invoiceIdParam);
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
        setSelectedId(invoiceIdParam);
        if (neededDir !== directionFilter) {
          setDirectionFilter(neededDir);
          // Tab switch triggers reload → invoices update → effect re-runs → invoice found → URL cleaned
        }
      });
  }, [searchParams, invoices, companyId, directionFilter]); // eslint-disable-line react-hooks/exhaustive-deps

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
    setChecked(new Set()); setSelectMode(false);
    if (ids.includes(selectedId || '')) setSelectedId(null);
    setPage(0); setAllLoaded(false); setInvoices([]);
    await reload(true);
  }, [deleteModal.ids, selectedId, reload]);

  const handleEdit = useCallback(async (u: InvoiceUpdate) => { if (!selectedId) return; await updateInvoice(selectedId, u); await reload(true); }, [selectedId, reload]);

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
  const selectedInvoice = invoices.find(i => i.id === selectedId) ?? (selectedId && detail ? detail : null);
  const allFilteredChecked = invoices.length > 0 && invoices.every(i => checked.has(i.id));

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
  }, [selectedId, detail?.id, setPageEntity]);

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
                <button key={s} onClick={() => { setStatusFilter(s); setAiSuggestedFilter(false); }} className={`flex-1 py-1 text-[10px] font-semibold rounded ${statusFilter === s && !aiSuggestedFilter ? 'bg-sky-100 text-sky-700 border border-sky-300' : 'bg-gray-50 text-gray-500 border border-gray-200'}`}>{s === 'all' ? 'Tutte' : STATUS_LABELS[s]}</button>
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
          <div className="flex-1 overflow-y-auto">
            {loadingList || companyLoading ? <div className="text-center py-8 text-gray-400 text-sm">Caricamento...</div>
              : invoices.length === 0 ? <div className="text-center py-8 text-gray-400 text-sm">Nessun risultato</div>
              : <>
                {invoices.map(inv => <InvoiceCard key={inv.id} inv={inv} selected={selectedId === inv.id} checked={checked.has(inv.id)} selectMode={selectMode} onSelect={() => setSelectedId(inv.id)} onCheck={() => toggleCheck(inv.id)} isMatched={matchedInvoiceIds.has(inv.id)} suggestionScore={invoiceScores.get(inv.id)} meta={classifMeta.get(inv.id)} />)}
                {!allLoaded && <div ref={bottomRef} className="py-4 text-center text-xs text-gray-400">{loadingMore ? 'Caricamento...' : ''}</div>}
              </>}
          </div>
        </div>
        {/* Detail */}
        <div className="flex-1 flex flex-col overflow-hidden bg-gray-50">
          {selectedInvoice ? <InvoiceDetail
            invoice={selectedInvoice}
            detail={detail}
            installments={installments}
            loadingDetail={loadingDetail}
            onEdit={handleEdit}
            onDelete={() => setDeleteModal({ open: true, ids: [selectedInvoice.id] })}
            onReload={reload}
            onPatchInvoice={patchInvoice}
            onOpenCounterparty={(mode) => {
              if (selectedInvoice.counterparty_id) {
                navigate(`/controparti?counterpartyId=${selectedInvoice.counterparty_id}&mode=${mode}`);
              } else {
                navigate('/controparti');
              }
            }}
            onOpenScadenzario={() => {
              const tab = selectedInvoice.direction === 'out' ? 'incassi' : 'pagamenti';
              const q = encodeURIComponent(selectedInvoice.number || '');
              navigate(`/scadenzario?tab=${tab}&period=all&status=all&invoiceId=${selectedInvoice.id}&query=${q}`);
            }}
            onNavigateCounterparty={() => {
              if (selectedInvoice.counterparty_id) {
                navigate(`/controparti?focus=${selectedInvoice.counterparty_id}`);
              } else {
                navigate('/controparti');
              }
            }}
          />
            : <div className="flex items-center justify-center h-full text-gray-400 text-sm">Seleziona una fattura dalla lista</div>}
        </div>
      </div>
    </div>
  );
}
