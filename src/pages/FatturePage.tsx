// src/pages/FatturePage.tsx — v5
// Date filter + AI search (Haiku) + removed Fix Nomi
import { useState, useCallback, useRef, useEffect, useMemo, useSyncExternalStore } from 'react';
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
  loadArticles, assignArticleToLine, removeLineAssignment, recordAssignmentFeedback, loadLearnedRules,
  type Article, type MatchResult,
} from '@/lib/articlesService';
import { matchWithLearnedRules, extractLocation } from '@/lib/articleMatching';
import {
  loadCategories, loadProjects, loadChartOfAccounts,
  loadInvoiceClassification, saveInvoiceClassification, deleteInvoiceClassification,
  loadInvoiceProjects, saveInvoiceProjects,
  loadLineClassifications, saveLineCategoryAndAccount,
  loadLineProjects, saveLineProjects,
  CATEGORY_TYPE_LABELS, SECTION_LABELS,
  type Category, type Project, type ChartAccount,
  type InvoiceClassification, type InvoiceProjectAssignment,
  type LineClassification, type LineProjectAssignment,
} from '@/lib/classificationService';

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
  // Classification icons: only show if at least one is active
  const hasAnyClassif = meta && (meta.assigned_count > 0 || meta.has_category || meta.has_cost_center || meta.has_account);
  return (
    <div className={`flex items-start gap-2 px-3 py-2.5 cursor-pointer border-b border-gray-100 transition-all ${checked ? 'bg-blue-50 border-l-4 border-l-blue-500' : selected ? 'bg-sky-50 border-l-4 border-l-sky-500' : 'border-l-4 border-l-transparent hover:bg-gray-50'}`}>
      {selectMode && <input type="checkbox" checked={checked} onChange={onCheck} className="mt-1 accent-blue-600 cursor-pointer flex-shrink-0" onClick={e => e.stopPropagation()} />}
      <div className="flex-1 min-w-0" onClick={onSelect}>
        <div className="flex justify-between items-center"><span className="text-xs font-semibold text-gray-800 truncate max-w-[55%]">{displayName}</span><span className={`text-xs font-bold ${nc ? 'text-red-600' : 'text-green-700'}`}>{fmtEur(inv.total_amount)}</span></div>
        <div className="flex justify-between items-center mt-0.5"><span className="text-[10px] text-gray-500">n.{inv.number} — {fmtDate(inv.date)}</span><span className="flex items-center gap-1">{inv.classification_status === 'ai_suggested' && <span className="text-[10px] text-amber-500" title="Classificazione AI da rivedere">⚡</span>}{isMatched && <ReconciledIcon size={12} />}{!isMatched && suggestionScore != null && <ReconciliationDot score={suggestionScore} invoiceId={inv.id} />}{nc && <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-red-100 text-red-700">NC</span>}<span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${STATUS_COLORS[inv.payment_status] || 'bg-gray-100 text-gray-600'}`}>{STATUS_LABELS[inv.payment_status] || inv.payment_status}</span></span></div>
        {hasAnyClassif && (
          <div className="flex items-center gap-1.5 mt-1">
            {meta!.assigned_count > 0 && (
              <span className={`text-[10px] ${meta!.assigned_count >= meta!.line_count ? 'text-emerald-600' : 'text-amber-500'}`} title={`Articoli: ${meta!.assigned_count}/${meta!.line_count}`}>
                📦
              </span>
            )}
            {meta!.has_category && <span className="text-[10px] text-emerald-600" title="Categoria assegnata">🏷️</span>}
            {meta!.has_cost_center && <span className="text-[10px] text-emerald-600" title="Centro di costo">🏗️</span>}
            {meta!.has_account && <span className="text-[10px] text-emerald-600" title="Piano dei conti">📒</span>}
          </div>
        )}
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
}

function ArticleDropdown({ articles, current, suggestion, onAssign, onRemove }: {
  articles: Article[]; current: LineArticleInfo | null;
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
// FULL INVOICE DETAIL — matches artifact output
// ============================================================
function InvoiceDetail({ invoice, detail, installments, loadingDetail, onEdit, onDelete, onReload, onPatchInvoice, onOpenCounterparty, onOpenScadenzario }: {
  invoice: DBInvoice; detail: DBInvoiceDetail | null; installments: InvoiceInstallment[]; loadingDetail: boolean;
  onEdit: (u: InvoiceUpdate) => Promise<void>; onDelete: () => void; onReload: () => void;
  onPatchInvoice: (invoiceId: string, patch: Partial<DBInvoice>) => void;
  onOpenCounterparty: (mode: 'verify' | 'edit') => void;
  onOpenScadenzario: () => void;
}) {
  const { company } = useCompany();
  const [editing, setEditing] = useState(false);
  const [showXml, setShowXml] = useState(false);
  const [parsed, setParsed] = useState<any>(null);

  // ─── Article assignment state ───
  const [articles, setArticles] = useState<Article[]>([]);
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

  // Load articles + existing assignments when invoice changes
  useEffect(() => {
    const companyId = company?.id;
    if (!companyId || !invoice?.id) { setArticles([]); setLineArticleMap({}); setAiSuggestions({}); return; }
    let cancelled = false;

    (async () => {
      // Load articles + learned rules for this company
      const [arts, rules] = await Promise.all([
        loadArticles(companyId, { activeOnly: true }),
        loadLearnedRules(companyId),
      ]);
      if (cancelled) return;
      setArticles(arts);

      // Load existing assignments for this invoice
      const { data: assignments } = await supabase
        .from('invoice_line_articles')
        .select('invoice_line_id, article_id, assigned_by, verified, location, confidence, article:articles!inner(id, code, name, unit, keywords)')
        .eq('invoice_id', invoice.id);

      if (cancelled) return;
      const map: Record<string, LineArticleInfo> = {};
      const dbSuggestions: Record<string, MatchResult> = {};

      for (const a of (assignments || [])) {
        const art = a.article as any;
        if (a.verified) {
          // Confirmed assignment → green badge
          map[a.invoice_line_id] = {
            article_id: a.article_id, code: art?.code || '', name: art?.name || '',
            assigned_by: a.assigned_by, verified: a.verified, location: a.location,
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
    } catch (e: any) { console.error('Save classification error:', e); }
    setClassifSaving(false);
  }, [company?.id, invoice?.id, selCategoryId, selAccountId, cdcRows, cdcMode]);

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

  // AI classification — request suggestion from edge function
  const handleRequestAiClassification = useCallback(async () => {
    if (!invoice?.id || !company?.id) return;
    setAiClassifStatus('loading');
    try {
      const token = await getValidAccessToken();
      const res = await fetch(`${SUPABASE_URL}/functions/v1/classification-ai-suggest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'apikey': SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ company_id: company.id, invoice_ids: [invoice.id] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Errore AI');
      const result = data.results?.[0] || null;
      setAiClassifResult(result);
      setAiClassifStatus('done');
      // Reload classification data to reflect persisted suggestions
      if (result) {
        const [classif, lineClf, lineProj] = await Promise.all([
          loadInvoiceClassification(invoice.id),
          loadLineClassifications(invoice.id),
          loadLineProjects(invoice.id),
        ]);
        if (classif) {
          setClassification(classif);
          setSelCategoryId(classif.category_id || selCategoryId);
          setSelAccountId(classif.account_id || selAccountId);
        }
        setLineClassifs(lineClf);
        setLineProjects(lineProj);
      }
    } catch (e: any) {
      console.error('AI classification error:', e);
      setAiClassifStatus('error');
    }
  }, [invoice?.id, company?.id, selCategoryId, selAccountId]);

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
    } catch (e: any) { console.error('Confirm AI classification error:', e); }
  }, [invoice?.id, company?.id, aiClassifResult, onPatchInvoice]);

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
    } catch (e: any) { console.error('Confirm existing classification error:', e); }
  }, [invoice?.id, company?.id, onPatchInvoice]);

  const handleAssignArticle = useCallback(async (lineId: string, articleId: string, lineDesc: string, lineData: { quantity: number; unit_price: number; total_price: number; vat_rate: number }) => {
    const companyId = company?.id;
    if (!companyId || !invoice?.id) return;
    const location = extractLocation(lineDesc);
    const art = articles.find(a => a.id === articleId);

    // Optimistic update BEFORE the network call — badge appears instantly
    const prevMap = { ...lineArticleMap };
    const prevSuggestions = { ...aiSuggestions };
    setLineArticleMap(prev => ({
      ...prev,
      [lineId]: {
        article_id: articleId, code: art?.code || '', name: art?.name || '',
        assigned_by: 'manual', verified: true, location,
      },
    }));
    setAiSuggestions(prev => { const n = { ...prev }; delete n[lineId]; return n; });

    try {
      // upsert handles both INSERT and UPDATE via onConflict: 'invoice_line_id'
      await assignArticleToLine(companyId, lineId, invoice.id, articleId, lineData, 'manual', undefined, location);
      // Record feedback for manual assignment → creates a learned rule
      if (lineDesc) {
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

  if (loadingDetail) return <div className="text-center py-16 text-gray-400">Caricamento dettaglio...</div>;

  const nc = invoice.doc_type === 'TD04' || invoice.doc_type === 'TD05';
  const d = parsed;
  const b = d?.bodies?.[0];
  const cp = (invoice.counterparty || {}) as any;
  const cpStatus = String(invoice.counterparty_status_snapshot || '').toLowerCase();
  const showCounterpartyAlert = cpStatus === 'pending' || cpStatus === 'rejected' || !invoice.counterparty_id;
  const hasRefs = b?.contratti?.length > 0 || b?.ordini?.length > 0 || b?.convenzioni?.length > 0;

  return (
    <div className="p-4 overflow-y-auto h-full" id="invoice-detail-print">
      {/* Action buttons */}
      <div className="flex justify-end gap-2 mb-3 print:hidden">
        {detail?.raw_xml && <button onClick={() => setShowXml(!showXml)} className={`px-3 py-1.5 text-xs font-semibold rounded-lg border ${showXml ? 'bg-sky-600 text-white border-sky-600' : 'bg-white text-sky-600 border-sky-300 hover:bg-sky-50'}`}>{showXml ? '✕ Chiudi XML' : '〈/〉 Vedi XML'}</button>}
        {detail?.raw_xml && <button onClick={downloadXml} className="px-3 py-1.5 text-xs font-semibold rounded-lg border bg-white text-sky-600 border-sky-300 hover:bg-sky-50">⬇ Scarica XML</button>}
        <button onClick={onOpenScadenzario} className="px-3 py-1.5 text-xs font-semibold rounded-lg border bg-white text-violet-600 border-violet-300 hover:bg-violet-50">🗓 Visualizza in Scadenzario</button>
        <button onClick={() => window.print()} className="px-3 py-1.5 text-xs font-semibold rounded-lg border bg-white text-gray-600 border-gray-300 hover:bg-gray-50">🖨 Stampa PDF</button>
        <button onClick={() => setEditing(!editing)} className={`px-3 py-1.5 text-xs font-semibold rounded-lg border ${editing ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-blue-600 border-blue-300 hover:bg-blue-50'}`}>{editing ? '✕ Chiudi' : '✏️ Modifica'}</button>
        <button onClick={onDelete} className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-red-300 text-red-600 bg-white hover:bg-red-50">🗑 Elimina</button>
      </div>

      {/* XML viewer */}
      {showXml && detail?.raw_xml && (
        <div className="mb-3 bg-gray-900 rounded-lg overflow-hidden border print:hidden">
          <div className="flex justify-between items-center px-3 py-2 bg-gray-800">
            <span className="text-sky-300 text-xs font-semibold">XML Sorgente — {Math.round(detail.raw_xml.length / 1024)} KB</span>
            <button onClick={() => navigator.clipboard?.writeText(detail.raw_xml)} className="bg-gray-700 text-gray-300 border-none rounded px-2 py-1 text-[10px] cursor-pointer hover:bg-gray-600">📋 Copia</button>
          </div>
          <pre className="m-0 p-3 text-gray-300 text-[10px] font-mono overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap break-all leading-relaxed">{detail.raw_xml}</pre>
        </div>
      )}

      {editing && <EditForm invoice={invoice} onSave={handleSave} onCancel={() => setEditing(false)} />}

      <Sec title="Rate / Scadenze">
        <div className="mb-2 flex justify-end">
          <button
            onClick={onOpenScadenzario}
            className="px-2.5 py-1 text-xs font-semibold rounded border border-violet-300 text-violet-700 bg-white hover:bg-violet-50"
          >
            Gestisci pagamenti da Scadenzario
          </button>
        </div>
        {!installments.length ? (
          <div className="text-xs text-gray-500">Nessuna rata disponibile per questa fattura.</div>
        ) : (
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr className="bg-sky-50 border-b border-sky-100">
                <th className="text-left px-2 py-1.5 text-sky-700 font-semibold">Rata</th>
                <th className="text-left px-2 py-1.5 text-sky-700 font-semibold">Scadenza</th>
                <th className="text-right px-2 py-1.5 text-sky-700 font-semibold">Importo</th>
                <th className="text-right px-2 py-1.5 text-sky-700 font-semibold">Pagato</th>
                <th className="text-left px-2 py-1.5 text-sky-700 font-semibold">Stato</th>
              </tr>
            </thead>
            <tbody>
              {installments.map((inst) => (
                <tr key={inst.id} className="border-b border-gray-100">
                  <td className="px-2 py-1.5">
                    {inst.installment_total > 1 ? `${inst.installment_no} di ${inst.installment_total}` : 'Unica'}
                  </td>
                  <td className="px-2 py-1.5">
                    {fmtDate(inst.due_date)}
                    {inst.is_estimated && <span className="ml-2 text-[10px] text-blue-700">stimata</span>}
                  </td>
                  <td className="px-2 py-1.5 text-right font-semibold">{fmtEur(inst.amount_due)}</td>
                  <td className="px-2 py-1.5 text-right">{fmtEur(inst.paid_amount)}</td>
                  <td className="px-2 py-1.5">
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                      inst.status === 'paid'
                        ? 'bg-emerald-100 text-emerald-700'
                        : inst.status === 'overdue'
                          ? 'bg-red-100 text-red-700'
                          : inst.status === 'partial'
                            ? 'bg-amber-100 text-amber-700'
                            : 'bg-gray-100 text-gray-700'
                    }`}>
                      {inst.status === 'paid' ? 'Pagata/Incassata' : inst.status === 'overdue' ? 'Scaduta' : inst.status === 'partial' ? 'Parziale' : 'Da saldare'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Sec>

      {showCounterpartyAlert && (
        <div className={`mb-4 rounded-lg border px-3 py-2.5 ${
          cpStatus === 'rejected' ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'
        }`}>
          <p className={`text-sm font-semibold ${cpStatus === 'rejected' ? 'text-red-800' : 'text-amber-800'}`}>
            {cpStatus === 'rejected' ? 'Controparte respinta' : 'Controparte da verificare'}
          </p>
          <p className={`text-xs mt-0.5 ${cpStatus === 'rejected' ? 'text-red-700' : 'text-amber-700'}`}>
            {cpStatus === 'rejected'
              ? 'I dati della controparte non sono stati validati. Controlla e correggi l’anagrafica.'
              : 'La controparte è stata creata automaticamente e richiede verifica utente.'}
          </p>
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => onOpenCounterparty('verify')}
              className="px-2.5 py-1 text-xs font-semibold rounded border border-sky-300 bg-white text-sky-700 hover:bg-sky-50"
            >
              Verifica controparte
            </button>
            <button
              onClick={() => onOpenCounterparty('edit')}
              className="px-2.5 py-1 text-xs font-semibold rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
            >
              Modifica dati
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="text-center mb-5 pb-4 border-b-2 border-sky-200">
        <h2 className="text-xl font-extrabold text-gray-900">{TIPO[invoice.doc_type] || invoice.doc_type} &nbsp; N. {invoice.number}</h2>
        <div className="flex justify-center gap-5 mt-2 flex-wrap">
          <span><span className="text-gray-500 text-xs">Data: </span><span className="text-sm font-semibold">{fmtDate(invoice.date)}</span></span>
          {d?.ver && <span><span className="text-gray-500 text-xs">Versione: </span><span className="text-xs font-semibold bg-sky-100 text-sky-700 px-1.5 py-0.5 rounded">{d.ver}</span></span>}
          <span><span className="text-gray-500 text-xs">Metodo: </span><span className="text-xs font-semibold bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">{invoice.parse_method}</span></span>
        </div>
      </div>

      {/* Da / Per */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        <Sec title="Da:">
          <Row l="Denominazione" v={d?.ced?.denom || cp?.denom} accent />
          <Row l="Partita IVA" v={d?.ced?.piva || cp?.piva} />
          <Row l="Codice Fiscale" v={d?.ced?.cf || cp?.cf} />
          <Row l="Regime Fiscale" v={d?.ced?.regime ? `${d.ced.regime} (${REG[d.ced.regime] || ''})` : undefined} />
          <Row l="Sede" v={d?.ced?.sede || cp?.sede} />
          <Row l="Iscrizione REA" v={d?.ced?.reaNumero ? `${d.ced.reaUfficio} ${d.ced.reaNumero}` : undefined} />
          <Row l="Capitale Sociale" v={d?.ced?.capitale ? fmtEur(safeFloat(d.ced.capitale)) : undefined} />
          <Row l="In Liquidazione" v={d?.ced?.liquidazione === 'LN' ? 'LN (No)' : d?.ced?.liquidazione === 'LS' ? 'LS (Sì)' : d?.ced?.liquidazione || undefined} />
          <Row l="Telefono" v={d?.ced?.tel} />
          <Row l="Email" v={d?.ced?.email} />
        </Sec>
        <Sec title="Per:">
          <Row l="Denominazione" v={d?.ces?.denom} accent />
          <Row l="Partita IVA" v={d?.ces?.piva} />
          <Row l="Codice Fiscale" v={d?.ces?.cf} />
          <Row l="Sede" v={d?.ces?.sede} />
        </Sec>
      </div>

      {/* Riferimenti */}
      {hasRefs && (
        <Sec title="Riferimenti">
          {b.contratti?.map((c: any, i: number) => <Row key={`c${i}`} l="Rif. Contratto" v={[c.id, c.data ? fmtDate(c.data) : '', c.cig ? `CIG:${c.cig}` : '', c.cup ? `CUP:${c.cup}` : ''].filter(Boolean).join(' — ')} />)}
          {b.ordini?.map((o: any, i: number) => <Row key={`o${i}`} l="Rif. Ordine" v={[o.id, o.data ? fmtDate(o.data) : '', o.cig ? `CIG:${o.cig}` : '', o.cup ? `CUP:${o.cup}` : ''].filter(Boolean).join(' — ')} />)}
          {b.convenzioni?.map((c: any, i: number) => <Row key={`v${i}`} l="Rif. Convenzione" v={[c.id, c.data ? fmtDate(c.data) : ''].filter(Boolean).join(' — ')} />)}
        </Sec>
      )}

      {/* Causali */}
      {b?.causali?.length > 0 && <Sec title="Causale (Note)">{b.causali.map((c: string, i: number) => <div key={i} className="text-xs text-gray-700 py-0.5">{c}</div>)}</Sec>}

      {/* Classificazione fattura */}
      {(allCategories.length > 0 || allAccounts.length > 0 || allProjects.length > 0) && (
        <Sec title="Classificazione fattura">
          <div className="space-y-3 print:hidden">
            {/* AI Suggestion Banner */}
            {invoice.classification_status === 'ai_suggested' && (
              <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <span className="text-amber-500 text-sm flex-shrink-0">⚡</span>
                <span className="text-xs text-amber-800 flex-1">Classificazione suggerita dall'AI — verifica e conferma</span>
                <button onClick={handleConfirmExistingClassification}
                  className="px-2.5 py-1 text-[11px] font-semibold rounded-md bg-emerald-600 text-white hover:bg-emerald-700 transition-colors flex-shrink-0">
                  ✓ Conferma
                </button>
                <button onClick={handleRejectAiClassification}
                  className="px-2.5 py-1 text-[11px] font-semibold rounded-md bg-red-100 text-red-700 hover:bg-red-200 transition-colors flex-shrink-0">
                  ✕ Rifiuta
                </button>
              </div>
            )}
            {/* Categoria */}
            {allCategories.length > 0 && (
              <div className="flex items-center gap-3">
                <label className="text-xs font-medium text-gray-600 w-24 flex-shrink-0">Categoria:</label>
                <select
                  value={selCategoryId || ''}
                  onChange={e => { setSelCategoryId(e.target.value || null); setClassifDirty(true); }}
                  className="flex-1 px-2.5 py-1.5 text-xs border border-gray-200 rounded-md bg-white focus:ring-2 focus:ring-sky-400 outline-none">
                  <option value="">— Nessuna —</option>
                  {allCategories.map(c => (
                    <option key={c.id} value={c.id}>{c.name} ({CATEGORY_TYPE_LABELS[c.type]})</option>
                  ))}
                </select>
                {selCategoryId && (() => {
                  const cat = allCategories.find(c => c.id === selCategoryId);
                  return cat ? <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: cat.color }} /> : null;
                })()}
              </div>
            )}

            {/* Piano dei conti */}
            {allAccounts.length > 0 && (
              <div className="flex items-center gap-3">
                <label className="text-xs font-medium text-gray-600 w-24 flex-shrink-0">Piano conti:</label>
                <select
                  value={selAccountId || ''}
                  onChange={e => { setSelAccountId(e.target.value || null); setClassifDirty(true); }}
                  className="flex-1 px-2.5 py-1.5 text-xs border border-gray-200 rounded-md bg-white focus:ring-2 focus:ring-sky-400 outline-none">
                  <option value="">— Nessuno —</option>
                  {allAccounts.map(a => (
                    <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Centri di costo — multi-CdC with %/amount */}
            {allProjects.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <label className="text-xs font-medium text-gray-600 w-24 flex-shrink-0">Centri di costo:</label>
                  <div className="flex gap-3 items-center">
                    <label className="flex items-center gap-1 text-[10px] text-gray-500 cursor-pointer">
                      <input type="radio" name="cdcMode" checked={cdcMode === 'percentage'} onChange={() => setCdcMode('percentage')} className="w-3 h-3 accent-sky-600" />
                      Percentuale
                    </label>
                    <label className="flex items-center gap-1 text-[10px] text-gray-500 cursor-pointer">
                      <input type="radio" name="cdcMode" checked={cdcMode === 'amount'} onChange={() => setCdcMode('amount')} className="w-3 h-3 accent-sky-600" />
                      Importo
                    </label>
                  </div>
                </div>

                {/* CdC rows */}
                {cdcRows.length > 0 ? (
                  <div className="ml-[108px] space-y-1">
                    {cdcRows.map(row => {
                      const proj = allProjects.find(p => p.id === row.project_id);
                      const invTotal = Math.abs(invoice?.total_amount || 0);
                      return (
                        <div key={row.project_id} className="flex items-center gap-2 rounded-md border border-gray-100 bg-gray-50/50 px-2 py-1">
                          <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: proj?.color || '#9ca3af' }} />
                          <span className="text-[10px] font-mono font-bold text-sky-700 min-w-[60px]">{proj?.code || '?'}</span>
                          <span className="text-[10px] text-gray-600 flex-1 truncate">{proj?.name || ''}</span>
                          {/* Percentage input */}
                          <input
                            type="number" min={0} max={100} step={0.01}
                            value={row.percentage}
                            onChange={e => handleCdcPctChange(row.project_id, Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                            disabled={cdcMode === 'amount'}
                            className={`w-16 px-1.5 py-0.5 text-[10px] border rounded text-center outline-none transition-colors ${
                              cdcMode === 'percentage' ? 'border-sky-300 bg-white focus:ring-1 focus:ring-sky-400' : 'border-gray-200 bg-gray-100 text-gray-400'
                            }`}
                          />
                          <span className="text-[10px] text-gray-400">%</span>
                          {/* Amount display/input */}
                          <input
                            type="number" step={0.01}
                            value={row.amount ?? (invTotal > 0 ? Math.round(invTotal * row.percentage / 100 * 100) / 100 : '')}
                            onChange={e => handleCdcAmtChange(row.project_id, Math.max(0, Number(e.target.value) || 0))}
                            disabled={cdcMode === 'percentage'}
                            className={`w-24 px-1.5 py-0.5 text-[10px] border rounded text-right outline-none transition-colors ${
                              cdcMode === 'amount' ? 'border-sky-300 bg-white focus:ring-1 focus:ring-sky-400' : 'border-gray-200 bg-gray-100 text-gray-400'
                            }`}
                          />
                          <span className="text-[10px] text-gray-400 min-w-[8px]">€</span>
                          {/* Remove */}
                          <button onClick={() => handleRemoveCdc(row.project_id)}
                            className="p-0.5 text-gray-300 hover:text-red-500 transition-colors text-xs font-bold leading-none">
                            ×
                          </button>
                        </div>
                      );
                    })}

                    {/* Totals row */}
                    {(() => {
                      const invTotal = Math.abs(invoice?.total_amount || 0);
                      const totalPct = Math.round(cdcRows.reduce((s, r) => s + r.percentage, 0) * 100) / 100;
                      const totalAmt = cdcRows.reduce((s, r) => s + (r.amount ?? (invTotal > 0 ? invTotal * r.percentage / 100 : 0)), 0);
                      const restPct = Math.round((100 - totalPct) * 100) / 100;
                      const restAmt = Math.round((invTotal - totalAmt) * 100) / 100;
                      const isComplete = Math.abs(restPct) < 0.01;
                      return (
                        <div className="flex items-center gap-2 px-2 py-1 border-t border-gray-200 mt-1">
                          <span className="text-[10px] font-semibold text-gray-500 flex-1">Totale:</span>
                          <span className={`w-16 text-[10px] font-bold text-center ${isComplete ? 'text-green-600' : 'text-amber-600'}`}>
                            {fmtNum(totalPct)}%
                          </span>
                          <span className="text-[10px] text-gray-400" />
                          <span className={`w-24 text-[10px] font-bold text-right ${isComplete ? 'text-green-600' : 'text-amber-600'}`}>
                            {fmtEur(totalAmt)}
                          </span>
                          <span className="min-w-[8px]" />
                          <span className="w-[16px]" />
                        </div>
                      );
                    })()}
                    {(() => {
                      const invTotal = Math.abs(invoice?.total_amount || 0);
                      const totalPct = Math.round(cdcRows.reduce((s, r) => s + r.percentage, 0) * 100) / 100;
                      const totalAmt = cdcRows.reduce((s, r) => s + (r.amount ?? (invTotal > 0 ? invTotal * r.percentage / 100 : 0)), 0);
                      const restPct = Math.round((100 - totalPct) * 100) / 100;
                      const restAmt = Math.round((invTotal - totalAmt) * 100) / 100;
                      if (Math.abs(restPct) < 0.01) return null;
                      return (
                        <div className="flex items-center gap-2 px-2">
                          <span className="text-[10px] text-amber-600 flex-1">Resta:</span>
                          <span className="w-16 text-[10px] text-amber-600 text-center">{fmtNum(restPct)}%</span>
                          <span className="text-[10px] text-gray-400" />
                          <span className="w-24 text-[10px] text-amber-600 text-right">{fmtEur(restAmt)}</span>
                          <span className="min-w-[8px]" />
                          <span className="w-[16px]" />
                        </div>
                      );
                    })()}
                  </div>
                ) : (
                  <div className="ml-[108px]">
                    <span className="text-xs text-gray-400 italic">Nessun centro di costo</span>
                  </div>
                )}

                {/* Add CdC row */}
                <div className="flex items-center gap-2 ml-[108px]">
                  <select value={addCdcId} onChange={e => setAddCdcId(e.target.value)}
                    className="flex-1 px-2 py-1 text-[11px] border border-gray-200 rounded-md bg-white focus:ring-1 focus:ring-sky-400 outline-none">
                    <option value="">+ Aggiungi centro di costo...</option>
                    {(() => {
                      const assignedIds = new Set(cdcRows.map(r => r.project_id));
                      const parents = allProjects.filter(p => !p.parent_id);
                      const children = allProjects.filter(p => !!p.parent_id);
                      return parents.map(parent => {
                        const kids = children.filter(c => c.parent_id === parent.id && !assignedIds.has(c.id));
                        const hasKids = children.some(c => c.parent_id === parent.id);
                        if (hasKids) {
                          if (kids.length === 0) return null;
                          return (
                            <optgroup key={parent.id} label={`${parent.code} — ${parent.name}`}>
                              {kids.map(c => (
                                <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
                              ))}
                            </optgroup>
                          );
                        } else {
                          if (assignedIds.has(parent.id)) return null;
                          return <option key={parent.id} value={parent.id}>{parent.code} — {parent.name}</option>;
                        }
                      });
                    })()}
                  </select>
                  <button onClick={handleAddCdc} disabled={!addCdcId}
                    className="px-2.5 py-1 text-[10px] font-semibold text-sky-700 bg-sky-50 border border-sky-200 rounded-md hover:bg-sky-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                    Aggiungi
                  </button>
                </div>
              </div>
            )}

            {/* CdC validation error */}
            {cdcRows.length > 0 && !cdcValidation.valid && (
              <div className="flex items-center gap-1.5 px-2 py-1.5 bg-red-50 border border-red-200 rounded-md">
                <span className="text-red-500 text-xs">⚠</span>
                <span className="text-[10px] text-red-700">{cdcValidation.message}</span>
              </div>
            )}

            {/* Save button */}
            {classifDirty && (
              <div className="flex justify-end pt-1">
                <button onClick={handleSaveClassification} disabled={classifSaving || !cdcValidation.valid}
                  className="px-3 py-1.5 text-xs font-semibold text-white bg-sky-600 rounded-md hover:bg-sky-700 disabled:opacity-50 transition-colors"
                  title={!cdcValidation.valid ? cdcValidation.message : ''}>
                  {classifSaving ? 'Salvataggio...' : 'Salva classificazione'}
                </button>
              </div>
            )}

            {/* AI Classification Suggestion */}
            {aiClassifResult && !classification?.verified && (
              <div className="bg-purple-50 border border-purple-200 rounded-lg px-3 py-2 mt-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-purple-600 text-sm">&#x2728;</span>
                  <span className="text-xs font-semibold text-purple-800">Suggerimento AI</span>
                  <span className="text-[10px] text-purple-500 ml-auto">
                    Confidenza: {aiClassifResult.invoice_level?.confidence ?? 0}%
                  </span>
                </div>
                {aiClassifResult.invoice_level?.reasoning && (
                  <p className="text-[10px] text-purple-700 mb-2">{aiClassifResult.invoice_level.reasoning}</p>
                )}
                <div className="text-[10px] text-purple-600 mb-2">
                  {aiClassifResult.lines?.length ?? 0} righe classificate
                  {' '}({aiClassifResult.lines?.filter((l: any) => l.match_type === 'deterministic').length ?? 0} deterministiche,
                  {' '}{aiClassifResult.lines?.filter((l: any) => l.match_type === 'ai').length ?? 0} AI)
                </div>
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

            {/* AI Classification Trigger */}
            {!classification && aiClassifStatus === 'idle' && !aiClassifResult && (
              <div className="flex justify-end pt-2">
                <button onClick={handleRequestAiClassification}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-purple-600 text-white hover:bg-purple-700 transition-colors">
                  <span>&#x2728;</span>
                  Suggerisci classificazione AI
                </button>
              </div>
            )}
            {aiClassifStatus === 'loading' && (
              <div className="flex items-center gap-2 pt-2 text-xs text-purple-600">
                <span className="animate-spin">&#x21BB;</span>
                Classificazione AI in corso...
              </div>
            )}
            {aiClassifStatus === 'error' && (
              <div className="flex items-center gap-2 pt-2">
                <span className="text-xs text-red-600">Errore classificazione AI</span>
                <button onClick={() => setAiClassifStatus('idle')} className="text-xs text-sky-600 hover:underline">Riprova</button>
              </div>
            )}
          </div>
        </Sec>
      )}

      {/* Beni/Servizi */}
      <Sec title="Dettaglio Beni e Servizi">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[11px]">
            <thead><tr className="bg-sky-50 border-b-2 border-sky-200">
              {b?.linee?.some((l: any) => l.codiceArticolo) && <th className="text-left px-1.5 py-1.5 text-sky-700 font-bold text-[10px]">Codice</th>}
              <th className="text-left px-1.5 py-1.5 text-sky-700 font-bold text-[10px]">Descrizione</th>
              <th className="text-right px-1.5 py-1.5 text-sky-700 font-bold text-[10px]">Qtà</th>
              <th className="text-right px-1.5 py-1.5 text-sky-700 font-bold text-[10px]">Prezzo Unit.</th>
              <th className="text-right px-1.5 py-1.5 text-sky-700 font-bold text-[10px]">IVA %</th>
              <th className="text-right px-1.5 py-1.5 text-sky-700 font-bold text-[10px]">Totale</th>
              {articles.length > 0 && <th className="text-right px-1.5 py-1.5 text-sky-700 font-bold text-[10px] print:hidden">Articolo</th>}
              {allCategories.length > 0 && <th className="text-center px-1 py-1.5 text-sky-700 font-bold text-[10px] print:hidden">Cat.</th>}
              {allProjects.length > 0 && <th className="text-center px-1 py-1.5 text-sky-700 font-bold text-[10px] print:hidden">CdC</th>}
              {allAccounts.length > 0 && <th className="text-center px-1 py-1.5 text-sky-700 font-bold text-[10px] print:hidden">Conto</th>}
            </tr></thead>
            <tbody>
              {(b?.linee || []).map((l: any, i: number) => {
                // Match XML line to DB invoice_lines by line_number for article assignment
                const dbLine = detail?.invoice_lines?.find(dl => dl.line_number === parseInt(l.numero || String(i + 1)));
                const lineId = dbLine?.id;
                return (
                <tr key={i} className="border-b border-gray-100">
                  {b?.linee?.some((x: any) => x.codiceArticolo) && <td className="text-left px-1.5 py-1 text-gray-400">{l.codiceArticolo || '—'}</td>}
                  <td className="text-left px-1.5 py-1">{l.descrizione}</td>
                  <td className="text-right px-1.5 py-1">{l.quantita ? fmtNum(safeFloat(l.quantita)) : '1'}</td>
                  <td className="text-right px-1.5 py-1">{fmtNum(safeFloat(l.prezzoUnitario))}</td>
                  <td className="text-right px-1.5 py-1">{fmtNum(safeFloat(l.aliquotaIVA))}%</td>
                  <td className="text-right px-1.5 py-1 font-bold">{fmtNum(safeFloat(l.prezzoTotale))}</td>
                  {articles.length > 0 && <td className="text-right px-1.5 py-1 print:hidden">
                    {lineId && <ArticleDropdown
                      articles={articles}
                      current={lineArticleMap[lineId] || null}
                      suggestion={aiSuggestions[lineId] || null}
                      onAssign={(artId) => handleAssignArticle(lineId, artId, l.descrizione || '', {
                        quantity: safeFloat(l.quantita) || 1, unit_price: safeFloat(l.prezzoUnitario),
                        total_price: safeFloat(l.prezzoTotale), vat_rate: safeFloat(l.aliquotaIVA),
                      })}
                      onRemove={() => handleRemoveArticle(lineId)}
                    />}
                  </td>}
                  {/* Line-level Cat/CdC/Conto columns — editable independently of article */}
                  {allCategories.length > 0 && <td className="text-center px-1 py-1 print:hidden">
                    {lineId ? (
                      <select
                        value={lineClassifs[lineId]?.category_id || ''}
                        onChange={e => handleLineClassifChange(lineId, 'category_id', e.target.value || null)}
                        className="w-full max-w-[80px] px-0.5 py-0.5 text-[9px] border border-transparent rounded bg-transparent hover:border-gray-200 hover:bg-white focus:border-sky-300 focus:bg-white outline-none cursor-pointer"
                        title={lineClassifs[lineId]?.category_id ? allCategories.find(c => c.id === lineClassifs[lineId]?.category_id)?.name : 'Eredita da fattura'}
                      >
                        <option value="" className="text-gray-400">{selCategoryId ? '← Fatt.' : '—'}</option>
                        {allCategories.map(c => <option key={c.id} value={c.id}>{c.name.substring(0, 12)}</option>)}
                      </select>
                    ) : (
                      <span className="text-[9px] text-gray-300 italic">—</span>
                    )}
                  </td>}
                  {allProjects.length > 0 && <td className="text-center px-1 py-1 print:hidden relative">
                    {lineId ? (
                      <>
                        <button
                          onClick={() => setCdcPopoverLineId(cdcPopoverLineId === lineId ? null : lineId)}
                          className="text-[9px] text-gray-500 hover:text-sky-700 hover:underline cursor-pointer w-full text-center"
                          title="Clicca per assegnare CdC a questa riga"
                        >
                          {lineProjects[lineId]?.length
                            ? lineProjects[lineId].map(lp => allProjects.find(p => p.id === lp.project_id)?.code).filter(Boolean).join(', ').substring(0, 12)
                            : (cdcRows.length > 0 ? '← Fatt.' : '—')
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
                            {/* Add CdC row */}
                            <div className="flex items-center gap-1 mt-1">
                              <select
                                className="flex-1 text-[9px] border rounded px-1 py-0.5"
                                value=""
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
                            {/* Save button */}
                            <button
                              onClick={async () => {
                                if (!company?.id || !invoice?.id) return;
                                try {
                                  const toSave = (lineProjects[lineId] || []).map(lp => ({
                                    project_id: lp.project_id,
                                    percentage: lp.percentage,
                                    amount: lp.amount,
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
                    ) : (
                      <span className="text-[9px] text-gray-300 italic">—</span>
                    )}
                  </td>}
                  {allAccounts.length > 0 && <td className="text-center px-1 py-1 print:hidden">
                    {lineId ? (
                      <select
                        value={lineClassifs[lineId]?.account_id || ''}
                        onChange={e => handleLineClassifChange(lineId, 'account_id', e.target.value || null)}
                        className="w-full max-w-[80px] px-0.5 py-0.5 text-[9px] border border-transparent rounded bg-transparent hover:border-gray-200 hover:bg-white focus:border-sky-300 focus:bg-white outline-none cursor-pointer"
                        title={lineClassifs[lineId]?.account_id ? allAccounts.find(a => a.id === lineClassifs[lineId]?.account_id)?.name : 'Eredita da fattura'}
                      >
                        <option value="" className="text-gray-400">{selAccountId ? '← Fatt.' : '—'}</option>
                        {allAccounts.map(a => <option key={a.id} value={a.id}>{a.code}</option>)}
                      </select>
                    ) : (
                      <span className="text-[9px] text-gray-300 italic">—</span>
                    )}
                  </td>}
                </tr>
                );
              })}
              {/* Fallback: DB line items when XML not parsed */}
              {!b?.linee?.length && detail?.invoice_lines?.map((l, i) => (
                <tr key={i} className="border-b border-gray-100">
                  <td className="text-left px-1.5 py-1">{l.description}</td>
                  <td className="text-right px-1.5 py-1">{fmtNum(l.quantity)}</td>
                  <td className="text-right px-1.5 py-1">{fmtNum(l.unit_price)}</td>
                  <td className="text-right px-1.5 py-1">{fmtNum(l.vat_rate)}%</td>
                  <td className="text-right px-1.5 py-1 font-bold">{fmtNum(l.total_price)}</td>
                  {articles.length > 0 && <td className="text-right px-1.5 py-1 print:hidden">
                    <ArticleDropdown
                      articles={articles}
                      current={lineArticleMap[l.id] || null}
                      suggestion={aiSuggestions[l.id] || null}
                      onAssign={(artId) => handleAssignArticle(l.id, artId, l.description, {
                        quantity: l.quantity, unit_price: l.unit_price,
                        total_price: l.total_price, vat_rate: l.vat_rate,
                      })}
                      onRemove={() => handleRemoveArticle(l.id)}
                    />
                  </td>}
                  {/* Line-level Cat/CdC/Conto — fallback rows — editable independently */}
                  {allCategories.length > 0 && <td className="text-center px-1 py-1 print:hidden">
                    <select
                      value={lineClassifs[l.id]?.category_id || ''}
                      onChange={e => handleLineClassifChange(l.id, 'category_id', e.target.value || null)}
                      className="w-full max-w-[80px] px-0.5 py-0.5 text-[9px] border border-transparent rounded bg-transparent hover:border-gray-200 hover:bg-white focus:border-sky-300 focus:bg-white outline-none cursor-pointer"
                    >
                      <option value="" className="text-gray-400">{selCategoryId ? '← Fatt.' : '—'}</option>
                      {allCategories.map(c => <option key={c.id} value={c.id}>{c.name.substring(0, 12)}</option>)}
                    </select>
                  </td>}
                  {allProjects.length > 0 && <td className="text-center px-1 py-1 print:hidden relative">
                    <button
                      onClick={() => setCdcPopoverLineId(cdcPopoverLineId === l.id ? null : l.id)}
                      className="text-[9px] text-gray-500 hover:text-sky-700 hover:underline cursor-pointer w-full text-center"
                      title="Clicca per assegnare CdC a questa riga"
                    >
                      {lineProjects[l.id]?.length
                        ? lineProjects[l.id].map(lp => allProjects.find(p => p.id === lp.project_id)?.code).filter(Boolean).join(', ').substring(0, 12)
                        : (cdcRows.length > 0 ? '← Fatt.' : '—')
                      }
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
                              <input type="number" min={0} max={100} step={1}
                                value={lp.percentage}
                                onChange={e => {
                                  const pct = Math.max(0, Math.min(100, Number(e.target.value)));
                                  setLineProjects(prev => ({
                                    ...prev,
                                    [l.id]: (prev[l.id] || []).map((r, ri) => ri === lpIdx ? { ...r, percentage: pct } : r),
                                  }));
                                }}
                                className="w-12 text-[9px] text-right border rounded px-1 py-0.5"
                              />
                              <span className="text-[9px] text-gray-400">%</span>
                              <button onClick={() => {
                                setLineProjects(prev => ({
                                  ...prev,
                                  [l.id]: (prev[l.id] || []).filter((_, ri) => ri !== lpIdx),
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
                                [l.id]: [...(prev[l.id] || []), { id: crypto.randomUUID(), invoice_line_id: l.id, project_id: e.target.value, percentage: 100, amount: null }],
                              }));
                            }}
                          >
                            <option value="">+ Aggiungi CdC</option>
                            {allProjects.filter(p => !(lineProjects[l.id] || []).some(lp => lp.project_id === p.id)).map(p => (
                              <option key={p.id} value={p.id}>{p.code} - {p.name}</option>
                            ))}
                          </select>
                        </div>
                        <button
                          onClick={async () => {
                            if (!company?.id || !invoice?.id) return;
                            try {
                              const toSave = (lineProjects[l.id] || []).map(lp => ({
                                project_id: lp.project_id, percentage: lp.percentage, amount: lp.amount,
                              }));
                              await saveLineProjects(company.id, invoice.id, l.id, toSave);
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
                  </td>}
                  {allAccounts.length > 0 && <td className="text-center px-1 py-1 print:hidden">
                    <select
                      value={lineClassifs[l.id]?.account_id || ''}
                      onChange={e => handleLineClassifChange(l.id, 'account_id', e.target.value || null)}
                      className="w-full max-w-[80px] px-0.5 py-0.5 text-[9px] border border-transparent rounded bg-transparent hover:border-gray-200 hover:bg-white focus:border-sky-300 focus:bg-white outline-none cursor-pointer"
                    >
                      <option value="" className="text-gray-400">{selAccountId ? '← Fatt.' : '—'}</option>
                      {allAccounts.map(a => <option key={a.id} value={a.id}>{a.code}</option>)}
                    </select>
                  </td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Sec>

      {/* Riepilogo IVA */}
      {b?.riepilogo?.length > 0 && (
        <Sec title="Riepilogo IVA e Totali">
          <table className="w-full border-collapse text-[11px]">
            <thead><tr className="bg-sky-50 border-b-2 border-sky-200">
              <th className="text-left px-1.5 py-1.5 text-sky-700 font-bold text-[10px]">Esigibilità IVA</th>
              <th className="text-left px-1.5 py-1.5 text-sky-700 font-bold text-[10px]">Aliquota IVA</th>
              <th className="text-right px-1.5 py-1.5 text-sky-700 font-bold text-[10px]">Imposta</th>
              <th className="text-right px-1.5 py-1.5 text-sky-700 font-bold text-[10px]">Imponibile</th>
            </tr></thead>
            <tbody>
              {b.riepilogo.map((r: any, i: number) => (
                <tr key={i} className="border-b border-gray-100">
                  <td className="text-left px-1.5 py-1">{r.esigibilita ? `${ESI[r.esigibilita] || r.esigibilita}` : ''}</td>
                  <td className="text-left px-1.5 py-1">{fmtNum(safeFloat(r.aliquota))}%{r.natura ? ` - ${r.natura} (${NAT[r.natura] || ''})` : ''}{r.rifNorm ? ` - ${r.rifNorm}` : ''}</td>
                  <td className="text-right px-1.5 py-1 font-bold">{fmtNum(safeFloat(r.imposta))}</td>
                  <td className="text-right px-1.5 py-1 font-bold">{fmtNum(safeFloat(r.imponibile))}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-sky-200">
                <td className="text-left px-1.5 py-1 font-bold">Totale Imposta e Imponibile</td><td></td>
                <td className="text-right px-1.5 py-1 font-bold text-sky-700">{fmtNum(b.riepilogo.reduce((s: number, r: any) => s + safeFloat(r.imposta), 0))}</td>
                <td className="text-right px-1.5 py-1 font-bold text-sky-700">{fmtNum(b.riepilogo.reduce((s: number, r: any) => s + safeFloat(r.imponibile), 0))}</td>
              </tr>
            </tbody>
          </table>
          <div className="mt-2 grid grid-cols-4 gap-2 bg-sky-50 p-2 rounded-lg text-xs">
            <div><div className="text-sky-700 font-bold text-[10px]">Importo Bollo</div><div className="font-semibold">{b.bollo?.importo ? fmtEur(safeFloat(b.bollo.importo)) : ''}</div></div>
            <div><div className="text-sky-700 font-bold text-[10px]">Sconto/Rincaro</div><div className="font-semibold">{
              b.sconti?.length > 0
                ? b.sconti.map((s: any, i: number) => {
                    const tipo = s.tipo === 'SC' ? 'Sconto' : s.tipo === 'MG' ? 'Maggiorazione' : s.tipo;
                    const val = s.importo ? fmtEur(-safeFloat(s.importo)) : s.percentuale ? `${s.percentuale}%` : '';
                    return <span key={i} className={`${s.tipo === 'SC' ? 'text-red-600' : 'text-green-700'}`}>{tipo}: {val}</span>;
                  })
                : (b.arrotondamento || '')
            }</div></div>
            <div><div className="text-sky-700 font-bold text-[10px]">Divisa</div><div className="font-semibold">{b.divisa}</div></div>
            <div className="text-right"><div className="text-sky-700 font-bold text-[10px]">Totale Documento</div><div className={`text-lg font-extrabold ${nc ? 'text-red-600' : 'text-green-700'}`}>{fmtEur((() => {
                const fromXml = safeFloat(b.totale);
                if (fromXml !== 0) return fromXml;
                const base = b.riepilogo?.reduce((s: number, r: any) => s + safeFloat(r.imponibile) + safeFloat(r.imposta), 0) || 0;
                const sconto = b.sconti?.reduce((s: number, sc: any) => s + (sc.tipo === 'SC' ? safeFloat(sc.importo) : -safeFloat(sc.importo)), 0) || 0;
                return Math.max(0, base - sconto);
              })())}</div></div>
          </div>
        </Sec>
      )}

      {/* Pagamento */}
      <Sec title="Modalità Pagamento">
        <table className="w-full border-collapse text-[11px]">
          <thead><tr className="bg-sky-50 border-b-2 border-sky-200">
            <th className="text-left px-1.5 py-1.5 text-sky-700 font-bold text-[10px]">Modalità</th>
            <th className="text-left px-1.5 py-1.5 text-sky-700 font-bold text-[10px]">IBAN</th>
            <th className="text-right px-1.5 py-1.5 text-sky-700 font-bold text-[10px]">Scadenza</th>
            <th className="text-right px-1.5 py-1.5 text-sky-700 font-bold text-[10px]">Importo</th>
          </tr></thead>
          <tbody>
            {b?.pagamenti?.length > 0 ? b.pagamenti.map((p: any, i: number) => (
              <tr key={i} className="border-b border-gray-100">
                <td className="text-left px-1.5 py-1">{p.modalita ? mpLabel(p.modalita) : ''}{b.condPag ? ` — ${tpLabel(b.condPag)}` : ''}</td>
                <td className="text-left px-1.5 py-1">{p.iban || ''}</td>
                <td className="text-right px-1.5 py-1">{p.scadenza ? fmtDate(p.scadenza) : ''}</td>
                <td className="text-right px-1.5 py-1 font-bold">{p.importo ? fmtEur(safeFloat(p.importo)) : ''}</td>
              </tr>
            )) : (
              <tr><td colSpan={4} className="text-left px-1.5 py-1 text-gray-400">
                {invoice.payment_method ? mpLabel(invoice.payment_method) : 'Nessun dettaglio'} — Scadenza: {invoice.payment_due_date ? fmtDate(invoice.payment_due_date) : '—'} — {fmtEur(invoice.total_amount)}
              </td></tr>
            )}
          </tbody>
        </table>
      </Sec>

      {/* DDT */}
      {b?.ddt?.length > 0 && <Sec title="Documenti di Trasporto" open={false}>{b.ddt.map((dd: any, i: number) => <div key={i}><Row l="DDT Numero" v={dd.numero} /><Row l="DDT Data" v={fmtDate(dd.data)} /></div>)}</Sec>}

      {/* Ritenuta */}
      {b?.ritenuta?.importo && <Sec title="Ritenuta d'Acconto" open={false}><Row l="Tipo" v={RIT[b.ritenuta.tipo] || b.ritenuta.tipo} /><Row l="Importo" v={fmtEur(safeFloat(b.ritenuta.importo))} accent /><Row l="Aliquota" v={b.ritenuta.aliquota ? `${fmtNum(safeFloat(b.ritenuta.aliquota))}%` : undefined} /><Row l="Causale Pag." v={b.ritenuta.causale} /></Sec>}

      {/* Cassa */}
      {b?.cassa?.importo && <Sec title="Cassa Previdenziale" open={false}><Row l="Tipo Cassa" v={b.cassa.tipo} /><Row l="Importo Contributo" v={fmtEur(safeFloat(b.cassa.importo))} accent /><Row l="Aliquota" v={b.cassa.al ? `${fmtNum(safeFloat(b.cassa.al))}%` : undefined} /></Sec>}

      {/* Allegati */}
      {b?.allegati?.length > 0 && (
        <Sec title="File Allegati">
          <table className="w-full border-collapse text-[11px]">
            <thead><tr className="bg-sky-50 border-b-2 border-sky-200">
              <th className="text-left px-1.5 py-1.5 text-sky-700 font-bold text-[10px]">Nome</th>
              <th className="text-left px-1.5 py-1.5 text-sky-700 font-bold text-[10px]">Formato</th>
              <th className="text-left px-1.5 py-1.5 text-sky-700 font-bold text-[10px]">Descrizione</th>
              <th className="text-right px-1.5 py-1.5 text-sky-700 font-bold text-[10px]">Dim.</th>
              <th className="text-right px-1.5 py-1.5 text-sky-700 font-bold text-[10px]">Scarica</th>
            </tr></thead>
            <tbody>
              {b.allegati.map((a: any, i: number) => (
                <tr key={i} className="border-b border-gray-100">
                  <td className="text-left px-1.5 py-1 text-sky-700">{a.nome}</td>
                  <td className="text-left px-1.5 py-1">{a.formato || '—'}</td>
                  <td className="text-left px-1.5 py-1">{a.descrizione || '—'}</td>
                  <td className="text-right px-1.5 py-1">{a.sizeKB > 0 ? `${a.sizeKB} KB` : '—'}</td>
                  <td className="text-right px-1.5 py-1">{a.hasData ? <button onClick={() => downloadAllegato(a)} className="bg-sky-600 text-white border-none rounded px-2 py-0.5 text-[10px] cursor-pointer font-semibold hover:bg-sky-700">⬇ Scarica</button> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Sec>
      )}

      {/* Trasmissione */}
      {d?.trasm && (
        <Sec title="Trasmissione" open={false}>
          <table className="w-full border-collapse text-[11px]">
            <thead><tr className="bg-sky-50 border-b-2 border-sky-200">
              <th className="text-left px-1.5 py-1.5 text-sky-700 font-bold text-[10px]">Cod. Destinatario</th>
              <th className="text-left px-1.5 py-1.5 text-sky-700 font-bold text-[10px]">Progressivo</th>
              <th className="text-left px-1.5 py-1.5 text-sky-700 font-bold text-[10px]">Telefono</th>
              <th className="text-left px-1.5 py-1.5 text-sky-700 font-bold text-[10px]">Email</th>
            </tr></thead>
            <tbody><tr className="border-b border-gray-100">
              <td className="text-left px-1.5 py-1">{d.trasm.codDest}</td>
              <td className="text-left px-1.5 py-1">{d.trasm.progressivo}</td>
              <td className="text-left px-1.5 py-1">{d.ced?.tel || '—'}</td>
              <td className="text-left px-1.5 py-1">{d.ced?.email || '—'}</td>
            </tr></tbody>
          </table>
        </Sec>
      )}

      <div className="text-center text-[10px] text-gray-400 mt-6 pb-4">
        {invoice.source_filename} — Metodo: {invoice.parse_method} — Hash: {invoice.xml_hash?.substring(0, 16)}...
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
      // Paginated fetch of ALL invoice IDs (Supabase max 1000 per call)
      const PAGE = 1000;
      const allInvIds: string[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data } = await supabase
          .from('invoices')
          .select('id')
          .eq('company_id', companyId)
          .eq('direction', directionFilter)
          .range(from, from + PAGE - 1);
        if (signal.aborted) return;
        if (!data || data.length === 0) break;
        for (const r of data) allInvIds.push(r.id);
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

      const ids = allInvIds.filter((id) => !classifiedSet.has(id));
      if (ids.length === 0) return;

      updateProgress(0, ids.length);
      const token = await getValidAccessToken();
      let successCount = 0;
      let failedCount = 0;

      // Split into batches of 10 IDs per API call, run 5 calls in parallel
      const BATCH_SIZE = 10;
      const PARALLEL = 5;
      const batches: string[][] = [];
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        batches.push(ids.slice(i, i + BATCH_SIZE));
      }

      const classifiedIds: string[] = [];

      for (let i = 0; i < batches.length; i += PARALLEL) {
        if (signal.aborted) return;
        const parallelBatches = batches.slice(i, i + PARALLEL);
        const results = await Promise.all(
          parallelBatches.map(async (batch) => {
            try {
              const res = await fetch(`${SUPABASE_URL}/functions/v1/classification-ai-suggest`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token}`,
                  'apikey': SUPABASE_ANON_KEY,
                },
                body: JSON.stringify({ company_id: companyId, invoice_ids: batch }),
                signal,
              });
              if (!res.ok) {
                console.error(`Batch classification error: HTTP ${res.status}`);
                return { success: 0, failed: batch.length, ids: [] as string[] };
              }
              const data = await res.json();
              const okIds = (data.results || []).map((r: any) => r.invoice_id).filter(Boolean);
              return { success: data.results?.length || 0, failed: data.stats?.failed || 0, ids: okIds as string[] };
            } catch (fetchErr: any) {
              if (fetchErr?.name === 'AbortError') throw fetchErr;
              console.error('Batch fetch error:', fetchErr);
              return { success: 0, failed: batch.length, ids: [] as string[] };
            }
          }),
        );
        for (const r of results) {
          successCount += r.success;
          failedCount += r.failed;
          classifiedIds.push(...r.ids);
        }
        const processed = Math.min((i + PARALLEL) * BATCH_SIZE, ids.length);
        updateProgress(processed, ids.length);
      }

      // Mark classified invoices as ai_suggested (bulk, 200 per call to stay within PostgREST limits)
      for (let i = 0; i < classifiedIds.length; i += 200) {
        const chunk = classifiedIds.slice(i, i + 200);
        await supabase.from('invoices').update({ classification_status: 'ai_suggested' } as any).in('id', chunk);
      }

      if (failedCount > 0 && successCount === 0) {
        throw new Error(`Classificazione fallita per tutte le ${ids.length} fatture`);
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
      while (!signal.aborted) {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/invoice-extract-summary`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ company_id: companyId, batch_size: 50 }),
          signal,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        totalProcessed += (data.processed || 0);
        const totalRemaining = totalProcessed + (data.total_pending || 0);
        updateProgress(totalProcessed, totalRemaining);
        if ((data.total_pending || 0) <= 0) break;
      }
      // Refresh stats after completion
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
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-2.5 bg-white border-b shadow-sm flex-shrink-0 flex-wrap print:hidden">
        <h1 className="text-lg font-bold text-gray-800">📄 Fatture {directionFilter === 'out' ? 'Attive' : directionFilter === 'in' ? 'Passive' : ''}</h1><div className="flex-1" />
        <span className="text-xs px-2 py-1 bg-gray-100 rounded font-medium">{stats.total} fatture</span>
        <span className="text-xs px-2 py-1 bg-yellow-100 text-yellow-800 rounded font-medium">{stats.daPagare} {directionFilter === 'out' ? 'da incassare' : 'da pagare'}</span>
        {stats.scadute > 0 && <span className="text-xs px-2 py-1 bg-red-100 text-red-800 rounded font-medium">{stats.scadute} scadute</span>}
        <span className="text-xs px-2 py-1 bg-green-100 text-green-800 rounded font-medium">{stats.pagate} {directionFilter === 'out' ? 'incassate' : 'pagate'}</span>
        <span className="text-xs px-2 py-1 bg-purple-100 text-purple-800 rounded font-medium">{stats.counterparties} {directionFilter === 'out' ? 'clienti' : 'fornitori'}</span>
        <span className="text-sm font-bold text-green-700">Totale: {fmtEur(stats.totalAmount)}</span>
        <button onClick={() => fileRef.current?.click()} className="px-3 py-1.5 text-xs font-semibold bg-sky-600 text-white rounded-lg hover:bg-sky-700">📥 Importa</button>
        <input ref={fileRef} type="file" multiple accept=".xml,.p7m,.zip" onChange={e => e.target.files && handleImport(e.target.files)} className="hidden" />
        {invoices.length > 0 && (
          <button
            onClick={runExtraction}
            disabled={!extractionRunning && extractionStats?.pending === 0}
            title={extractionRunning ? 'Ferma estrazione' : 'Estrae dettagli strutturati dalle fatture XML tramite AI'}
            className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
              extractionRunning
                ? 'text-red-700 bg-red-50 border border-red-200 hover:bg-red-100'
                : 'text-sky-700 bg-sky-50 border border-sky-200 hover:bg-sky-100 disabled:opacity-50'
            }`}
          >
            {extractionRunning ? (
              <>⏹ Stop ({extractionJobProgress.pct}%)</>
            ) : extractionStats?.pending === 0 ? (
              <>📋 Estratte: {extractionStats?.ready ?? 0}/{extractionStats?.total ?? 0}</>
            ) : (
              <>📋 Estrai dettagli{extractionStats ? ` (${extractionStats.pending})` : ''}</>
            )}
          </button>
        )}
        {invoices.length > 0 && (
          <button
            onClick={runBatchAiClassification}
            title={batchClassifRunning ? 'Ferma classificazione' : 'Classifica automaticamente categoria, conto e CdC per le fatture non classificate'}
            className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
              batchClassifRunning
                ? 'text-red-700 bg-red-50 border border-red-200 hover:bg-red-100'
                : 'text-purple-700 bg-purple-50 border border-purple-200 hover:bg-purple-100'
            }`}
          >
            {batchClassifRunning
              ? <>⏹ Stop ({batchClassifJobProgress.pct}%)</>
              : <>🏷️ Classifica AI</>
            }
          </button>
        )}
      </div>

      {importing && <div className="px-4 pt-3 print:hidden"><ImportProgress phase={importPhase} current={importCurrent} total={importTotal} logs={importLogs} /></div>}

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div className="w-80 border-r bg-white flex flex-col flex-shrink-0 print:hidden">
          {/* Direction tabs */}
          <div className="flex border-b">
            {([['in', 'Passive (Ricevute)'], ['out', 'Attive (Emesse)']] as const).map(([k, label]) => (
              <button key={k} onClick={() => setDirectionFilter(k)} className={`flex-1 py-2.5 text-xs font-bold transition-all ${directionFilter === k ? (k === 'in' ? 'text-orange-700 border-b-2 border-orange-500 bg-orange-50' : 'text-emerald-700 border-b-2 border-emerald-500 bg-emerald-50') : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50'}`}>
                {label}
                <span className={`ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full ${directionFilter === k ? (k === 'in' ? 'bg-orange-200 text-orange-800' : 'bg-emerald-200 text-emerald-800') : 'bg-gray-100 text-gray-500'}`}>
                  {tabCounts[k]}
                </span>
              </button>
            ))}
          </div>
          <div className="p-2 border-b space-y-2">
            {/* Search with AI button */}
            <div className="flex gap-1">
              <input
                value={query}
                onChange={e => handleQueryChange(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && query.trim()) handleAISearch(); }}
                placeholder={directionFilter === 'out' ? '🔍 Cerca o Invio per AI ✨' : '🔍 Cerca o Invio per AI ✨'}
                className="flex-1 px-2.5 py-1.5 text-xs border rounded-lg bg-gray-50 outline-none focus:ring-1 focus:ring-sky-400"
              />
              <button
                onClick={handleAISearch}
                disabled={aiSearching || !query.trim()}
                title="Ricerca AI — cerca anche per sinonimi e categorie"
                className={`px-2 py-1.5 text-xs font-semibold rounded-lg border transition-all ${aiSearching ? 'bg-violet-100 text-violet-600 border-violet-300 animate-pulse' : aiResult ? 'bg-violet-600 text-white border-violet-600' : 'bg-white text-violet-600 border-violet-300 hover:bg-violet-50 disabled:opacity-40 disabled:cursor-not-allowed'}`}
              >
                {aiSearching ? '⏳' : '✨'}
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
        <div className="flex-1 overflow-y-auto bg-gray-50">
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
          />
            : <div className="flex items-center justify-center h-full text-gray-400 text-sm">Seleziona una fattura dalla lista</div>}
        </div>
      </div>
    </div>
  );
}
