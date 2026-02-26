// src/pages/FatturePage.tsx — v4
// Full detail view with inline XML parser, export XML/PDF, multi-select, delete, edit
import { useState, useCallback, useRef, useEffect } from 'react';
import { processInvoiceFile, TIPO, MP, REG } from '@/lib/invoiceParser';
import {
  saveInvoicesToDB, loadInvoices, loadInvoiceDetail,
  deleteInvoices, updateInvoice, verifyPassword,
  type DBInvoice, type DBInvoiceDetail, type InvoiceUpdate,
} from '@/lib/invoiceSaver';
import { useCompany } from '@/hooks/useCompany';
import { fmtNum, fmtEur, fmtDate } from '@/lib/utils';

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
const CPC: Record<string, string> = { TP01: 'A rate', TP02: 'Completo', TP03: 'Anticipo' };
const ESI: Record<string, string> = { I: 'Immediata', D: 'Differita', S: 'Split payment' };
const RIT: Record<string, string> = { RT01: 'Pers. fisiche', RT02: 'Pers. giuridiche', RT03: 'INPS', RT04: 'ENASARCO', RT05: 'ENPAM' };
const STATUS_LABELS: Record<string, string> = { pending: 'Da Pagare', overdue: 'Scaduta', paid: 'Pagata' };
const STATUS_COLORS: Record<string, string> = { pending: 'bg-yellow-100 text-yellow-800', overdue: 'bg-red-100 text-red-800', paid: 'bg-green-100 text-green-800' };

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
  const [form, setForm] = useState<InvoiceUpdate>({ number: invoice.number, date: invoice.date, total_amount: invoice.total_amount, payment_status: invoice.payment_status, payment_due_date: invoice.payment_due_date || '', payment_method: invoice.payment_method, notes: invoice.notes });
  const [saving, setSaving] = useState(false);
  const handleSave = async () => { setSaving(true); try { await onSave(form); } finally { setSaving(false); } };
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
      <h4 className="text-sm font-bold text-blue-800 mb-3">✏️ Modifica Fattura</h4>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="block text-xs font-medium text-gray-600 mb-1">Numero</label><input value={form.number || ''} onChange={e => setForm({ ...form, number: e.target.value })} className="w-full px-2 py-1.5 text-sm border rounded focus:ring-1 focus:ring-blue-400 outline-none" /></div>
        <div><label className="block text-xs font-medium text-gray-600 mb-1">Data</label><input type="date" value={form.date || ''} onChange={e => setForm({ ...form, date: e.target.value })} className="w-full px-2 py-1.5 text-sm border rounded focus:ring-1 focus:ring-blue-400 outline-none" /></div>
        <div><label className="block text-xs font-medium text-gray-600 mb-1">Totale (€)</label><input type="number" step="0.01" value={form.total_amount ?? ''} onChange={e => setForm({ ...form, total_amount: parseFloat(e.target.value) || 0 })} className="w-full px-2 py-1.5 text-sm border rounded focus:ring-1 focus:ring-blue-400 outline-none" /></div>
        <div><label className="block text-xs font-medium text-gray-600 mb-1">Stato</label><select value={form.payment_status || 'pending'} onChange={e => setForm({ ...form, payment_status: e.target.value })} className="w-full px-2 py-1.5 text-sm border rounded focus:ring-1 focus:ring-blue-400 outline-none"><option value="pending">Da Pagare</option><option value="overdue">Scaduta</option><option value="paid">Pagata</option></select></div>
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
      <div className="flex items-center justify-between mb-2"><span className="text-sm font-semibold text-gray-700">{phase === 'reading' ? '📖 Lettura file...' : phase === 'saving' ? '💾 Salvataggio...' : '✅ Completato'}</span><span className="text-sm text-gray-500">{current}/{total} ({pct}%)</span></div>
      <div className="w-full bg-gray-200 rounded-full h-2 mb-3"><div className={`h-2 rounded-full transition-all duration-300 ${phase === 'done' ? 'bg-green-500' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} /></div>
      <div className="flex gap-4 text-xs"><span className="text-green-700">✓ {okC} importati</span><span className="text-yellow-700">⊘ {dupC} duplicati</span><span className="text-red-700">✕ {errC} errori</span></div>
      {errC > 0 && <div className="mt-3 max-h-40 overflow-y-auto">{logs.filter(l => l.status.startsWith('error')).map((l, i) => <div key={i} className="text-xs text-red-600 bg-red-50 rounded px-2 py-1 mb-1 font-mono truncate">✕ {l.fn}: {l.message}</div>)}</div>}
    </div>
  );
}

// ============================================================
// SIDEBAR CARD
// ============================================================
function InvoiceCard({ inv, selected, checked, selectMode, onSelect, onCheck }: { inv: DBInvoice; selected: boolean; checked: boolean; selectMode: boolean; onSelect: () => void; onCheck: () => void }) {
  const nc = inv.doc_type === 'TD04' || inv.doc_type === 'TD05';
  const cp = (inv.counterparty || {}) as any;
  const displayName = cp?.denom || inv.source_filename || 'Sconosciuto';
  return (
    <div className={`flex items-start gap-2 px-3 py-2.5 cursor-pointer border-b border-gray-100 transition-all ${checked ? 'bg-blue-50 border-l-4 border-l-blue-500' : selected ? 'bg-sky-50 border-l-4 border-l-sky-500' : 'border-l-4 border-l-transparent hover:bg-gray-50'}`}>
      {selectMode && <input type="checkbox" checked={checked} onChange={onCheck} className="mt-1 accent-blue-600 cursor-pointer flex-shrink-0" onClick={e => e.stopPropagation()} />}
      <div className="flex-1 min-w-0" onClick={onSelect}>
        <div className="flex justify-between items-center"><span className="text-xs font-semibold text-gray-800 truncate max-w-[55%]">{displayName}</span><span className={`text-xs font-bold ${nc ? 'text-red-600' : 'text-green-700'}`}>{fmtEur(inv.total_amount)}</span></div>
        <div className="flex justify-between items-center mt-0.5"><span className="text-[10px] text-gray-500">n.{inv.number} — {fmtDate(inv.date)}</span><span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${STATUS_COLORS[inv.payment_status] || 'bg-gray-100 text-gray-600'}`}>{STATUS_LABELS[inv.payment_status] || inv.payment_status}</span></div>
      </div>
    </div>
  );
}

// ============================================================
// FULL INVOICE DETAIL — matches artifact output
// ============================================================
function InvoiceDetail({ invoice, detail, loadingDetail, onEdit, onDelete, onReload }: {
  invoice: DBInvoice; detail: DBInvoiceDetail | null; loadingDetail: boolean;
  onEdit: (u: InvoiceUpdate) => Promise<void>; onDelete: () => void; onReload: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [showXml, setShowXml] = useState(false);
  const [parsed, setParsed] = useState<any>(null);

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
  const hasRefs = b?.contratti?.length > 0 || b?.ordini?.length > 0 || b?.convenzioni?.length > 0;

  return (
    <div className="p-4 overflow-y-auto h-full" id="invoice-detail-print">
      {/* Action buttons */}
      <div className="flex justify-end gap-2 mb-3 print:hidden">
        {detail?.raw_xml && <button onClick={() => setShowXml(!showXml)} className={`px-3 py-1.5 text-xs font-semibold rounded-lg border ${showXml ? 'bg-sky-600 text-white border-sky-600' : 'bg-white text-sky-600 border-sky-300 hover:bg-sky-50'}`}>{showXml ? '✕ Chiudi XML' : '〈/〉 Vedi XML'}</button>}
        {detail?.raw_xml && <button onClick={downloadXml} className="px-3 py-1.5 text-xs font-semibold rounded-lg border bg-white text-sky-600 border-sky-300 hover:bg-sky-50">⬇ Scarica XML</button>}
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
          <Row l="Capitale Sociale" v={d?.ced?.capitale ? fmtEur(parseFloat(d.ced.capitale)) : undefined} />
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
            </tr></thead>
            <tbody>
              {(b?.linee || []).map((l: any, i: number) => (
                <tr key={i} className="border-b border-gray-100">
                  {b?.linee?.some((x: any) => x.codiceArticolo) && <td className="text-left px-1.5 py-1 text-gray-400">{l.codiceArticolo || '—'}</td>}
                  <td className="text-left px-1.5 py-1">{l.descrizione}</td>
                  <td className="text-right px-1.5 py-1">{l.quantita ? fmtNum(parseFloat(l.quantita)) : '1'}</td>
                  <td className="text-right px-1.5 py-1">{fmtNum(parseFloat(l.prezzoUnitario))}</td>
                  <td className="text-right px-1.5 py-1">{fmtNum(parseFloat(l.aliquotaIVA))}%</td>
                  <td className="text-right px-1.5 py-1 font-bold">{fmtNum(parseFloat(l.prezzoTotale))}</td>
                </tr>
              ))}
              {/* Fallback: DB line items when XML not parsed */}
              {!b?.linee?.length && detail?.invoice_lines?.map((l, i) => (
                <tr key={i} className="border-b border-gray-100">
                  <td className="text-left px-1.5 py-1">{l.description}</td>
                  <td className="text-right px-1.5 py-1">{fmtNum(l.quantity)}</td>
                  <td className="text-right px-1.5 py-1">{fmtNum(l.unit_price)}</td>
                  <td className="text-right px-1.5 py-1">{fmtNum(l.vat_rate)}%</td>
                  <td className="text-right px-1.5 py-1 font-bold">{fmtNum(l.total_price)}</td>
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
                  <td className="text-left px-1.5 py-1">{fmtNum(parseFloat(r.aliquota))}%{r.natura ? ` - ${r.natura} (${NAT[r.natura] || ''})` : ''}{r.rifNorm ? ` - ${r.rifNorm}` : ''}</td>
                  <td className="text-right px-1.5 py-1 font-bold">{fmtNum(parseFloat(r.imposta))}</td>
                  <td className="text-right px-1.5 py-1 font-bold">{fmtNum(parseFloat(r.imponibile))}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-sky-200">
                <td className="text-left px-1.5 py-1 font-bold">Totale Imposta e Imponibile</td><td></td>
                <td className="text-right px-1.5 py-1 font-bold text-sky-700">{fmtNum(b.riepilogo.reduce((s: number, r: any) => s + parseFloat(r.imposta || 0), 0))}</td>
                <td className="text-right px-1.5 py-1 font-bold text-sky-700">{fmtNum(b.riepilogo.reduce((s: number, r: any) => s + parseFloat(r.imponibile || 0), 0))}</td>
              </tr>
            </tbody>
          </table>
          <div className="mt-2 grid grid-cols-4 gap-2 bg-sky-50 p-2 rounded-lg text-xs">
            <div><div className="text-sky-700 font-bold text-[10px]">Importo Bollo</div><div className="font-semibold">{b.bollo?.importo ? fmtEur(parseFloat(b.bollo.importo)) : ''}</div></div>
            <div><div className="text-sky-700 font-bold text-[10px]">Sconto/Rincaro</div><div className="font-semibold">{b.arrotondamento || ''}</div></div>
            <div><div className="text-sky-700 font-bold text-[10px]">Divisa</div><div className="font-semibold">{b.divisa}</div></div>
            <div className="text-right"><div className="text-sky-700 font-bold text-[10px]">Totale Documento</div><div className={`text-lg font-extrabold ${nc ? 'text-red-600' : 'text-green-700'}`}>{fmtEur(parseFloat(b.totale))}</div></div>
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
                <td className="text-left px-1.5 py-1">{p.modalita ? `${p.modalita} (${MP[p.modalita] || ''})` : ''}{b.condPag ? ` - ${b.condPag} (${CPC[b.condPag] || ''})` : ''}</td>
                <td className="text-left px-1.5 py-1">{p.iban || ''}</td>
                <td className="text-right px-1.5 py-1">{p.scadenza ? fmtDate(p.scadenza) : ''}</td>
                <td className="text-right px-1.5 py-1 font-bold">{p.importo ? fmtEur(parseFloat(p.importo)) : ''}</td>
              </tr>
            )) : (
              <tr><td colSpan={4} className="text-left px-1.5 py-1 text-gray-400">
                {invoice.payment_method ? `${invoice.payment_method} (${MP[invoice.payment_method] || ''})` : 'Nessun dettaglio'} — Scadenza: {invoice.payment_due_date ? fmtDate(invoice.payment_due_date) : '—'} — {fmtEur(invoice.total_amount)}
              </td></tr>
            )}
          </tbody>
        </table>
      </Sec>

      {/* DDT */}
      {b?.ddt?.length > 0 && <Sec title="Documenti di Trasporto" open={false}>{b.ddt.map((dd: any, i: number) => <div key={i}><Row l="DDT Numero" v={dd.numero} /><Row l="DDT Data" v={fmtDate(dd.data)} /></div>)}</Sec>}

      {/* Ritenuta */}
      {b?.ritenuta?.importo && <Sec title="Ritenuta d'Acconto" open={false}><Row l="Tipo" v={RIT[b.ritenuta.tipo] || b.ritenuta.tipo} /><Row l="Importo" v={fmtEur(parseFloat(b.ritenuta.importo))} accent /><Row l="Aliquota" v={b.ritenuta.aliquota ? `${fmtNum(parseFloat(b.ritenuta.aliquota))}%` : undefined} /><Row l="Causale Pag." v={b.ritenuta.causale} /></Sec>}

      {/* Cassa */}
      {b?.cassa?.importo && <Sec title="Cassa Previdenziale" open={false}><Row l="Tipo Cassa" v={b.cassa.tipo} /><Row l="Importo Contributo" v={fmtEur(parseFloat(b.cassa.importo))} accent /><Row l="Aliquota" v={b.cassa.al ? `${fmtNum(parseFloat(b.cassa.al))}%` : undefined} /></Sec>}

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
// MAIN PAGE
// ============================================================
export default function FatturePage() {
  const { company, loading: companyLoading, ensureCompany, refetch: refetchCompany } = useCompany();
  const companyId = company?.id || null;
  const [invoices, setInvoices] = useState<DBInvoice[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DBInvoiceDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importPhase, setImportPhase] = useState<'reading' | 'saving' | 'done'>('reading');
  const [importCurrent, setImportCurrent] = useState(0);
  const [importTotal, setImportTotal] = useState(0);
  const [importLogs, setImportLogs] = useState<ImportLog[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'overdue' | 'paid'>('all');
  const [selectMode, setSelectMode] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [deleteModal, setDeleteModal] = useState<{ open: boolean; ids: string[] }>({ open: false, ids: [] });

  const reload = useCallback(async () => {
    if (!companyId) return;
    setLoadingList(true);
    try { setInvoices(await loadInvoices(companyId)); } catch (e) { console.error('Errore:', e); }
    setLoadingList(false);
  }, [companyId]);
  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let c = false; setLoadingDetail(true);
    loadInvoiceDetail(selectedId).then(d => { if (!c) { setDetail(d); setLoadingDetail(false); } });
    return () => { c = true; };
  }, [selectedId]);

  const handleImport = useCallback(async (files: FileList | File[]) => {
    if (!files.length) return;
    setImporting(true); setImportPhase('reading'); setImportCurrent(0); setImportTotal(0); setImportLogs([]);
    const parsed: any[] = []; let totalFiles = 0;
    for (const f of Array.from(files)) {
      try {
        const results = await processInvoiceFile(f); totalFiles += results.length; setImportTotal(totalFiles);
        for (const r of results) { parsed.push(r); setImportCurrent(parsed.length); if (r.err) setImportLogs(prev => [...prev, { fn: r.fn, status: 'error_parse', message: r.err }]); }
      } catch (e: any) { parsed.push({ fn: f.name, err: e.message }); setImportLogs(prev => [...prev, { fn: f.name, status: 'error_parse', message: e.message }]); }
    }
    let cid = companyId;
    const firstOk = parsed.find(r => !r.err && r.data);
    if (firstOk) { try { const eid = await ensureCompany(firstOk.data.ces); if (eid) cid = eid; await refetchCompany(); } catch {} }
    if (!cid) { setImporting(false); return; }
    const okParsed = parsed.filter(r => !r.err && r.data);
    setImportPhase('saving'); setImportCurrent(0); setImportTotal(okParsed.length);
    await saveInvoicesToDB(cid, okParsed, (cur, tot, status, fn) => {
      setImportCurrent(cur); setImportTotal(tot);
      setImportLogs(prev => [...prev, { fn, status: status === 'ok' ? 'ok' : status === 'duplicate' ? 'duplicate' : 'error_save', message: status === 'error' ? 'Errore salvataggio' : undefined }]);
    });
    setImportPhase('done'); await reload(); setTimeout(() => setImporting(false), 3000);
  }, [companyId, ensureCompany, refetchCompany, reload]);

  const handleDeleteConfirm = useCallback(async (_pw: string) => {
    const ids = deleteModal.ids; setDeleteModal({ open: false, ids: [] });
    try { await deleteInvoices(ids); } catch {}
    setChecked(new Set()); setSelectMode(false);
    if (ids.includes(selectedId || '')) setSelectedId(null);
    await reload();
  }, [deleteModal.ids, selectedId, reload]);

  const handleEdit = useCallback(async (u: InvoiceUpdate) => { if (!selectedId) return; await updateInvoice(selectedId, u); await reload(); }, [selectedId, reload]);

  const filtered = invoices.filter(inv => {
    if (statusFilter !== 'all' && inv.payment_status !== statusFilter) return false;
    if (!query) return true;
    const s = query.toLowerCase(); const cp = (inv.counterparty || {}) as any;
    return (cp?.denom || '').toLowerCase().includes(s) || inv.number.toLowerCase().includes(s) || inv.source_filename.toLowerCase().includes(s);
  });

  const toggleCheck = (id: string) => setChecked(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selectAll = () => {
    const fids = new Set(filtered.map(i => i.id));
    const allC = filtered.every(i => checked.has(i.id));
    setChecked(prev => { const n = new Set(prev); fids.forEach(id => allC ? n.delete(id) : n.add(id)); return n; });
  };

  const stats = {
    total: invoices.length,
    totalAmount: invoices.reduce((s, i) => s + (i.doc_type === 'TD04' ? -1 : 1) * i.total_amount, 0),
    daPagare: invoices.filter(i => i.payment_status === 'pending').length,
    scadute: invoices.filter(i => i.payment_status === 'overdue').length,
    pagate: invoices.filter(i => i.payment_status === 'paid').length,
    fornitori: new Set(invoices.map(i => (i.counterparty as any)?.denom || i.source_filename)).size,
  };
  const selectedInvoice = invoices.find(i => i.id === selectedId);
  const allFilteredChecked = filtered.length > 0 && filtered.every(i => checked.has(i.id));

  return (
    <div className="h-full flex flex-col bg-gray-50">
      <ConfirmDeleteModal open={deleteModal.open} count={deleteModal.ids.length} onConfirm={handleDeleteConfirm} onCancel={() => setDeleteModal({ open: false, ids: [] })} />
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-2.5 bg-white border-b shadow-sm flex-shrink-0 flex-wrap print:hidden">
        <h1 className="text-lg font-bold text-gray-800">📄 Fatture</h1><div className="flex-1" />
        <span className="text-xs px-2 py-1 bg-gray-100 rounded font-medium">{stats.total} fatture</span>
        <span className="text-xs px-2 py-1 bg-yellow-100 text-yellow-800 rounded font-medium">{stats.daPagare} da pagare</span>
        {stats.scadute > 0 && <span className="text-xs px-2 py-1 bg-red-100 text-red-800 rounded font-medium">{stats.scadute} scadute</span>}
        <span className="text-xs px-2 py-1 bg-green-100 text-green-800 rounded font-medium">{stats.pagate} pagate</span>
        <span className="text-xs px-2 py-1 bg-purple-100 text-purple-800 rounded font-medium">{stats.fornitori} fornitori</span>
        <span className="text-sm font-bold text-green-700">Totale: {fmtEur(stats.totalAmount)}</span>
        <button onClick={() => fileRef.current?.click()} className="px-3 py-1.5 text-xs font-semibold bg-sky-600 text-white rounded-lg hover:bg-sky-700">📥 Importa</button>
        <input ref={fileRef} type="file" multiple accept=".xml,.p7m,.zip" onChange={e => e.target.files && handleImport(e.target.files)} className="hidden" />
      </div>

      {importing && <div className="px-4 pt-3 print:hidden"><ImportProgress phase={importPhase} current={importCurrent} total={importTotal} logs={importLogs} /></div>}

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div className="w-80 border-r bg-white flex flex-col flex-shrink-0 print:hidden">
          <div className="p-2 border-b space-y-2">
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="🔍 Cerca fornitore, numero..." className="w-full px-2.5 py-1.5 text-xs border rounded-lg bg-gray-50 outline-none focus:ring-1 focus:ring-sky-400" />
            <div className="flex gap-1">
              {(['all', 'pending', 'overdue', 'paid'] as const).map(s => (
                <button key={s} onClick={() => setStatusFilter(s)} className={`flex-1 py-1 text-[10px] font-semibold rounded ${statusFilter === s ? 'bg-sky-100 text-sky-700 border border-sky-300' : 'bg-gray-50 text-gray-500 border border-gray-200'}`}>{s === 'all' ? 'Tutte' : STATUS_LABELS[s]}</button>
              ))}
            </div>
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
              : filtered.length === 0 ? <div className="text-center py-8 text-gray-400 text-sm">{invoices.length === 0 ? 'Nessuna fattura importata' : 'Nessun risultato'}</div>
              : filtered.map(inv => <InvoiceCard key={inv.id} inv={inv} selected={selectedId === inv.id} checked={checked.has(inv.id)} selectMode={selectMode} onSelect={() => setSelectedId(inv.id)} onCheck={() => toggleCheck(inv.id)} />)}
          </div>
        </div>
        {/* Detail */}
        <div className="flex-1 overflow-y-auto bg-gray-50">
          {selectedInvoice ? <InvoiceDetail invoice={selectedInvoice} detail={detail} loadingDetail={loadingDetail} onEdit={handleEdit} onDelete={() => setDeleteModal({ open: true, ids: [selectedInvoice.id] })} onReload={reload} />
            : <div className="flex items-center justify-center h-full text-gray-400 text-sm">Seleziona una fattura dalla lista</div>}
        </div>
      </div>
    </div>
  );
}
