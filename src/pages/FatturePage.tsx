// src/pages/FatturePage.tsx — v3
// Multi-select, eliminazione bulk/singola con popup password, modifica inline
import { useState, useCallback, useRef, useEffect } from 'react';
import { processInvoiceFile, TIPO, MP, REG, reparseXml } from '@/lib/invoiceParser';
import {
  saveInvoicesToDB,
  loadInvoices,
  loadInvoiceDetail,
  deleteInvoices,
  updateInvoice,
  verifyPassword,
  type DBInvoice,
  type DBInvoiceDetail,
  type InvoiceUpdate,
} from '@/lib/invoiceSaver';
import { useCompany } from '@/hooks/useCompany';
import { fmtNum, fmtEur, fmtDate } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';

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
const CP: Record<string, string> = { TP01: 'A rate', TP02: 'Completo', TP03: 'Anticipo' };
const ESI: Record<string, string> = { I: 'Immediata', D: 'Differita', S: 'Split payment' };
const STATUS_LABELS: Record<string, string> = {
  da_pagare: 'Da Pagare',
  scaduta: 'Scaduta',
  pagata: 'Pagata',
};
const STATUS_COLORS: Record<string, string> = {
  da_pagare: 'bg-yellow-100 text-yellow-800',
  scaduta: 'bg-red-100 text-red-800',
  pagata: 'bg-green-100 text-green-800',
};

// ============================================================
// CONFIRM MODAL — richiede password per operazioni sensibili
// ============================================================
function ConfirmDeleteModal({
  open,
  count,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  count: number;
  onConfirm: (password: string) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setPassword('');
      setError('');
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  if (!open) return null;

  const handleConfirm = async () => {
    if (!password.trim()) {
      setError('Inserisci la password');
      return;
    }
    setLoading(true);
    setError('');
    const ok = await verifyPassword(password);
    setLoading(false);
    if (ok) {
      onConfirm(password);
    } else {
      setError('Password errata');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onCancel}>
      <div className="bg-white rounded-xl shadow-2xl p-6 max-w-md w-full mx-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
            <span className="text-red-600 text-lg">🗑</span>
          </div>
          <div>
            <h3 className="text-lg font-bold text-gray-900">Conferma Eliminazione</h3>
            <p className="text-sm text-gray-500">
              {count === 1 ? 'Stai per eliminare 1 fattura' : `Stai per eliminare ${count} fatture`}
            </p>
          </div>
        </div>

        <p className="text-sm text-gray-600 mb-4">
          Questa azione è <span className="font-semibold text-red-600">irreversibile</span>. Le fatture e tutte le righe dettaglio associate verranno eliminate permanentemente. Inserisci la tua password per confermare.
        </p>

        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
          <input
            ref={inputRef}
            type="password"
            value={password}
            onChange={e => { setPassword(e.target.value); setError(''); }}
            onKeyDown={e => e.key === 'Enter' && handleConfirm()}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none"
            placeholder="Inserisci la tua password"
          />
          {error && <p className="text-sm text-red-600 mt-1">{error}</p>}
        </div>

        <div className="flex justify-end gap-3">
          <button onClick={onCancel} className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">
            Annulla
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50"
          >
            {loading ? 'Verifica...' : `Elimina ${count} fattur${count === 1 ? 'a' : 'e'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// EDIT FORM — modifica inline fattura
// ============================================================
function EditForm({
  invoice,
  onSave,
  onCancel,
}: {
  invoice: DBInvoice;
  onSave: (updates: InvoiceUpdate) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<InvoiceUpdate>({
    number: invoice.number,
    date: invoice.date,
    total_amount: invoice.total_amount,
    payment_status: invoice.payment_status,
    payment_due_date: invoice.payment_due_date || '',
    payment_method: invoice.payment_method,
    notes: invoice.notes,
  });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(form);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
      <h4 className="text-sm font-bold text-blue-800 mb-3">✏️ Modifica Fattura</h4>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Numero</label>
          <input
            value={form.number || ''}
            onChange={e => setForm({ ...form, number: e.target.value })}
            className="w-full px-2 py-1.5 text-sm border rounded focus:ring-1 focus:ring-blue-400 outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Data</label>
          <input
            type="date"
            value={form.date || ''}
            onChange={e => setForm({ ...form, date: e.target.value })}
            className="w-full px-2 py-1.5 text-sm border rounded focus:ring-1 focus:ring-blue-400 outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Totale (€)</label>
          <input
            type="number"
            step="0.01"
            value={form.total_amount ?? ''}
            onChange={e => setForm({ ...form, total_amount: parseFloat(e.target.value) || 0 })}
            className="w-full px-2 py-1.5 text-sm border rounded focus:ring-1 focus:ring-blue-400 outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Stato Pagamento</label>
          <select
            value={form.payment_status || 'da_pagare'}
            onChange={e => setForm({ ...form, payment_status: e.target.value })}
            className="w-full px-2 py-1.5 text-sm border rounded focus:ring-1 focus:ring-blue-400 outline-none"
          >
            <option value="da_pagare">Da Pagare</option>
            <option value="scaduta">Scaduta</option>
            <option value="pagata">Pagata</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Scadenza Pagamento</label>
          <input
            type="date"
            value={form.payment_due_date || ''}
            onChange={e => setForm({ ...form, payment_due_date: e.target.value || null })}
            className="w-full px-2 py-1.5 text-sm border rounded focus:ring-1 focus:ring-blue-400 outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Modalità Pagamento</label>
          <select
            value={form.payment_method || ''}
            onChange={e => setForm({ ...form, payment_method: e.target.value })}
            className="w-full px-2 py-1.5 text-sm border rounded focus:ring-1 focus:ring-blue-400 outline-none"
          >
            <option value="">—</option>
            {Object.entries(MP).map(([k, v]) => (
              <option key={k} value={k}>{k} — {v}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="mt-3">
        <label className="block text-xs font-medium text-gray-600 mb-1">Note</label>
        <textarea
          value={form.notes || ''}
          onChange={e => setForm({ ...form, notes: e.target.value })}
          rows={2}
          className="w-full px-2 py-1.5 text-sm border rounded focus:ring-1 focus:ring-blue-400 outline-none resize-none"
        />
      </div>
      <div className="flex justify-end gap-2 mt-3">
        <button onClick={onCancel} className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded hover:bg-gray-200">
          Annulla
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? 'Salvataggio...' : '💾 Salva Modifiche'}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// IMPORT PROGRESS / LOG
// ============================================================
interface ImportLog {
  fn: string;
  status: 'ok' | 'duplicate' | 'error_parse' | 'error_save';
  message?: string;
}

function ImportProgress({
  phase,
  current,
  total,
  logs,
}: {
  phase: 'reading' | 'saving' | 'done';
  current: number;
  total: number;
  logs: ImportLog[];
}) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  const okCount = logs.filter(l => l.status === 'ok').length;
  const dupCount = logs.filter(l => l.status === 'duplicate').length;
  const errCount = logs.filter(l => l.status.startsWith('error')).length;

  return (
    <div className="bg-white border rounded-lg p-4 mb-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-gray-700">
          {phase === 'reading' ? '📖 Lettura file...' : phase === 'saving' ? '💾 Salvataggio su DB...' : '✅ Import completato'}
        </span>
        <span className="text-sm text-gray-500">{current}/{total} ({pct}%)</span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-2 mb-3">
        <div
          className={`h-2 rounded-full transition-all duration-300 ${phase === 'done' ? 'bg-green-500' : 'bg-blue-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex gap-4 text-xs">
        <span className="text-green-700">✓ {okCount} importati</span>
        <span className="text-yellow-700">⊘ {dupCount} duplicati</span>
        <span className="text-red-700">✕ {errCount} errori</span>
      </div>

      {/* Error log */}
      {errCount > 0 && (
        <div className="mt-3 max-h-40 overflow-y-auto">
          {logs.filter(l => l.status.startsWith('error')).map((l, i) => (
            <div key={i} className="text-xs text-red-600 bg-red-50 rounded px-2 py-1 mb-1 font-mono truncate">
              ✕ {l.fn}: {l.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// INVOICE SIDEBAR CARD
// ============================================================
function InvoiceCard({
  inv,
  selected,
  checked,
  selectMode,
  onSelect,
  onCheck,
}: {
  inv: DBInvoice;
  selected: boolean;
  checked: boolean;
  selectMode: boolean;
  onSelect: () => void;
  onCheck: () => void;
}) {
  const nc = inv.doc_type === 'TD04' || inv.doc_type === 'TD05';
  const cp = inv.counterparty as any;

  return (
    <div
      className={`flex items-start gap-2 px-3 py-2.5 cursor-pointer border-b border-gray-100 transition-all ${
        checked ? 'bg-blue-50 border-l-4 border-l-blue-500' : selected ? 'bg-sky-50 border-l-4 border-l-sky-500' : 'border-l-4 border-l-transparent hover:bg-gray-50'
      }`}
    >
      {selectMode && (
        <input
          type="checkbox"
          checked={checked}
          onChange={onCheck}
          className="mt-1 accent-blue-600 cursor-pointer flex-shrink-0"
          onClick={e => e.stopPropagation()}
        />
      )}
      <div className="flex-1 min-w-0" onClick={onSelect}>
        <div className="flex justify-between items-center">
          <span className="text-xs font-semibold text-gray-800 truncate max-w-[55%]">
            {cp?.denom || 'Sconosciuto'}
          </span>
          <span className={`text-xs font-bold ${nc ? 'text-red-600' : 'text-green-700'}`}>
            {fmtEur(inv.total_amount)}
          </span>
        </div>
        <div className="flex justify-between items-center mt-0.5">
          <span className="text-[10px] text-gray-500">
            n.{inv.number} — {fmtDate(inv.date)}
          </span>
          <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${STATUS_COLORS[inv.payment_status] || 'bg-gray-100 text-gray-600'}`}>
            {STATUS_LABELS[inv.payment_status] || inv.payment_status}
          </span>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// INVOICE DETAIL VIEW
// ============================================================
function InvoiceDetail({
  invoice,
  detail,
  loadingDetail,
  onEdit,
  onDelete,
  onReload,
}: {
  invoice: DBInvoice;
  detail: DBInvoiceDetail | null;
  loadingDetail: boolean;
  onEdit: (updates: InvoiceUpdate) => Promise<void>;
  onDelete: () => void;
  onReload: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const nc = invoice.doc_type === 'TD04' || invoice.doc_type === 'TD05';
  const cp = invoice.counterparty as any;

  const handleSave = async (updates: InvoiceUpdate) => {
    await onEdit(updates);
    setEditing(false);
    onReload();
  };

  return (
    <div className="p-5 overflow-y-auto h-full">
      {/* Action buttons */}
      <div className="flex justify-end gap-2 mb-4">
        <button
          onClick={() => setEditing(!editing)}
          className={`px-3 py-1.5 text-xs font-semibold rounded-lg border ${editing ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-blue-600 border-blue-300 hover:bg-blue-50'}`}
        >
          {editing ? '✕ Chiudi Modifica' : '✏️ Modifica'}
        </button>
        <button
          onClick={onDelete}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-red-300 text-red-600 bg-white hover:bg-red-50"
        >
          🗑 Elimina
        </button>
      </div>

      {/* Edit form */}
      {editing && (
        <EditForm invoice={invoice} onSave={handleSave} onCancel={() => setEditing(false)} />
      )}

      {/* Header */}
      <div className="text-center mb-5 pb-4 border-b-2 border-sky-200">
        <h2 className="text-xl font-extrabold text-gray-900">
          {TIPO[invoice.doc_type] || invoice.doc_type} &nbsp; N. {invoice.number}
        </h2>
        <div className="flex justify-center gap-4 mt-2 flex-wrap text-sm">
          <span><span className="text-gray-500">Data: </span><span className="font-semibold">{fmtDate(invoice.date)}</span></span>
          <span className={`px-2 py-0.5 rounded text-xs font-semibold ${STATUS_COLORS[invoice.payment_status] || 'bg-gray-100'}`}>
            {STATUS_LABELS[invoice.payment_status] || invoice.payment_status}
          </span>
          <span className="text-gray-500 text-xs">File: {invoice.source_filename}</span>
        </div>
      </div>

      {/* Da / Per */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div className="bg-white border rounded-lg p-3">
          <h4 className="text-xs font-bold text-sky-700 mb-2">Da (Fornitore):</h4>
          <div className="space-y-1 text-xs">
            <div className="flex justify-between"><span className="text-gray-500">Denominazione</span><span className="font-semibold text-sky-700 text-right max-w-[60%]">{cp?.denom}</span></div>
            {cp?.piva && <div className="flex justify-between"><span className="text-gray-500">Partita IVA</span><span>{cp.piva}</span></div>}
            {cp?.cf && <div className="flex justify-between"><span className="text-gray-500">Codice Fiscale</span><span>{cp.cf}</span></div>}
            {cp?.sede && <div className="flex justify-between"><span className="text-gray-500">Sede</span><span className="text-right max-w-[60%]">{cp.sede}</span></div>}
          </div>
        </div>
        <div className="bg-white border rounded-lg p-3">
          <h4 className="text-xs font-bold text-sky-700 mb-2">Pagamento:</h4>
          <div className="space-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-gray-500">Modalità</span>
              <span>{invoice.payment_method ? `${invoice.payment_method} (${MP[invoice.payment_method] || ''})` : '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Scadenza</span>
              <span>{invoice.payment_due_date ? fmtDate(invoice.payment_due_date) : '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Totale</span>
              <span className={`text-base font-extrabold ${nc ? 'text-red-600' : 'text-green-700'}`}>{fmtEur(invoice.total_amount)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Note */}
      {invoice.notes && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-4">
          <h4 className="text-xs font-bold text-yellow-800 mb-1">📝 Note / Causale</h4>
          <p className="text-xs text-gray-700">{invoice.notes}</p>
        </div>
      )}

      {/* Righe dettaglio */}
      {loadingDetail ? (
        <div className="text-center py-8 text-gray-400 text-sm">Caricamento righe...</div>
      ) : detail?.invoice_lines && detail.invoice_lines.length > 0 ? (
        <div className="bg-white border rounded-lg overflow-hidden mb-4">
          <h4 className="text-xs font-bold text-sky-700 px-3 py-2 bg-sky-50 border-b">Dettaglio Beni e Servizi</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-sky-50/50">
                  <th className="text-left px-2 py-1.5 font-semibold text-sky-700">#</th>
                  <th className="text-left px-2 py-1.5 font-semibold text-sky-700">Descrizione</th>
                  <th className="text-right px-2 py-1.5 font-semibold text-sky-700">Qtà</th>
                  <th className="text-right px-2 py-1.5 font-semibold text-sky-700">Prezzo Unit.</th>
                  <th className="text-right px-2 py-1.5 font-semibold text-sky-700">IVA %</th>
                  <th className="text-right px-2 py-1.5 font-semibold text-sky-700">Totale</th>
                </tr>
              </thead>
              <tbody>
                {detail.invoice_lines.map((l, i) => (
                  <tr key={l.id || i} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-2 py-1.5 text-gray-400">{l.line_number || i + 1}</td>
                    <td className="px-2 py-1.5 text-gray-700 max-w-xs">{l.description}</td>
                    <td className="px-2 py-1.5 text-right">{fmtNum(l.quantity)}</td>
                    <td className="px-2 py-1.5 text-right">{fmtNum(l.unit_price)}</td>
                    <td className="px-2 py-1.5 text-right">{fmtNum(l.vat_rate)}%</td>
                    <td className="px-2 py-1.5 text-right font-semibold">{fmtNum(l.total_price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="text-center py-6 text-gray-400 text-xs">Nessuna riga dettaglio disponibile</div>
      )}

      {/* Meta */}
      <div className="text-center text-[10px] text-gray-400 mt-8">
        ID: {invoice.id} — Metodo: {invoice.parse_method} — Hash: {invoice.xml_hash?.substring(0, 16)}...
      </div>
    </div>
  );
}

// ============================================================
// MAIN PAGE
// ============================================================
export default function FatturePage() {
  const { companyId, ensureCompany } = useCompany();

  // Data
  const [invoices, setInvoices] = useState<DBInvoice[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DBInvoiceDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingList, setLoadingList] = useState(false);

  // Import
  const [importing, setImporting] = useState(false);
  const [importPhase, setImportPhase] = useState<'reading' | 'saving' | 'done'>('reading');
  const [importCurrent, setImportCurrent] = useState(0);
  const [importTotal, setImportTotal] = useState(0);
  const [importLogs, setImportLogs] = useState<ImportLog[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  // Filters
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'da_pagare' | 'scaduta' | 'pagata'>('all');

  // Multi-select
  const [selectMode, setSelectMode] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  // Delete modal
  const [deleteModal, setDeleteModal] = useState<{ open: boolean; ids: string[] }>({ open: false, ids: [] });

  // ---- LOAD INVOICES ----
  const reload = useCallback(async () => {
    if (!companyId) return;
    setLoadingList(true);
    try {
      const data = await loadInvoices(companyId);
      setInvoices(data);
    } catch (e) {
      console.error('Errore caricamento fatture:', e);
    }
    setLoadingList(false);
  }, [companyId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // ---- LOAD DETAIL ----
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let cancelled = false;
    setLoadingDetail(true);
    loadInvoiceDetail(selectedId).then(d => {
      if (!cancelled) { setDetail(d); setLoadingDetail(false); }
    });
    return () => { cancelled = true; };
  }, [selectedId]);

  // ---- IMPORT ----
  const handleImport = useCallback(async (files: FileList | File[]) => {
    if (!files.length) return;
    setImporting(true);
    setImportPhase('reading');
    setImportCurrent(0);
    setImportTotal(0);
    setImportLogs([]);

    // Phase 1: Parse files
    const parsed: any[] = [];
    const fileArr = Array.from(files);
    let totalFiles = 0;

    for (const f of fileArr) {
      try {
        const results = await processInvoiceFile(f);
        totalFiles += results.length;
        setImportTotal(totalFiles);
        for (const r of results) {
          parsed.push(r);
          setImportCurrent(parsed.length);
          if (r.err) {
            setImportLogs(prev => [...prev, { fn: r.fn, status: 'error_parse', message: r.err }]);
          }
        }
      } catch (e: any) {
        parsed.push({ fn: f.name, err: e.message });
        setImportLogs(prev => [...prev, { fn: f.name, status: 'error_parse', message: e.message }]);
      }
    }

    // Auto-create company from first invoice if needed
    const firstOk = parsed.find(r => !r.err && r.data);
    if (firstOk) {
      await ensureCompany(firstOk.data.ces);
    }

    const cid = companyId || (await supabase.auth.getUser()).data.user?.id;
    if (!cid) {
      setImporting(false);
      return;
    }

    // Phase 2: Save to DB
    const okParsed = parsed.filter(r => !r.err && r.data);
    setImportPhase('saving');
    setImportCurrent(0);
    setImportTotal(okParsed.length);

    await saveInvoicesToDB(cid, okParsed, (current, total, status, filename) => {
      setImportCurrent(current);
      setImportTotal(total);
      if (status === 'ok') {
        setImportLogs(prev => [...prev, { fn: filename, status: 'ok' }]);
      } else if (status === 'duplicate') {
        setImportLogs(prev => [...prev, { fn: filename, status: 'duplicate' }]);
      } else {
        setImportLogs(prev => [...prev, { fn: filename, status: 'error_save', message: 'Errore salvataggio' }]);
      }
    });

    setImportPhase('done');
    await reload();
    setTimeout(() => setImporting(false), 3000);
  }, [companyId, ensureCompany, reload]);

  // ---- DELETE ----
  const handleDeleteConfirm = useCallback(async (_password: string) => {
    const ids = deleteModal.ids;
    setDeleteModal({ open: false, ids: [] });

    try {
      const result = await deleteInvoices(ids);
      console.log(`Eliminate ${result.deleted} fatture`, result.errors);
    } catch (e) {
      console.error('Errore eliminazione:', e);
    }

    // Deselect and reload
    setChecked(new Set());
    setSelectMode(false);
    if (ids.includes(selectedId || '')) setSelectedId(null);
    await reload();
  }, [deleteModal.ids, selectedId, reload]);

  // ---- EDIT ----
  const handleEdit = useCallback(async (updates: InvoiceUpdate) => {
    if (!selectedId) return;
    await updateInvoice(selectedId, updates);
    await reload();
  }, [selectedId, reload]);

  // ---- FILTERS ----
  const filtered = invoices.filter(inv => {
    if (statusFilter !== 'all' && inv.payment_status !== statusFilter) return false;
    if (!query) return true;
    const s = query.toLowerCase();
    const cp = inv.counterparty as any;
    return (
      (cp?.denom || '').toLowerCase().includes(s) ||
      inv.number.toLowerCase().includes(s) ||
      inv.source_filename.toLowerCase().includes(s)
    );
  });

  // ---- MULTI-SELECT ----
  const toggleCheck = (id: string) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    const filteredIds = new Set(filtered.map(i => i.id));
    const allChecked = filtered.every(i => checked.has(i.id));
    if (allChecked) {
      // Deselect all filtered
      setChecked(prev => {
        const next = new Set(prev);
        filteredIds.forEach(id => next.delete(id));
        return next;
      });
    } else {
      // Select all filtered
      setChecked(prev => {
        const next = new Set(prev);
        filteredIds.forEach(id => next.add(id));
        return next;
      });
    }
  };

  // ---- STATS ----
  const stats = {
    total: invoices.length,
    totalAmount: invoices.reduce((s, i) => s + (i.doc_type === 'TD04' ? -1 : 1) * i.total_amount, 0),
    daPagare: invoices.filter(i => i.payment_status === 'da_pagare').length,
    scadute: invoices.filter(i => i.payment_status === 'scaduta').length,
    pagate: invoices.filter(i => i.payment_status === 'pagata').length,
    fornitori: new Set(invoices.map(i => (i.counterparty as any)?.denom)).size,
  };

  const selectedInvoice = invoices.find(i => i.id === selectedId);
  const allFilteredChecked = filtered.length > 0 && filtered.every(i => checked.has(i.id));

  // ============================================================
  // RENDER
  // ============================================================
  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Delete Modal */}
      <ConfirmDeleteModal
        open={deleteModal.open}
        count={deleteModal.ids.length}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteModal({ open: false, ids: [] })}
      />

      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-2.5 bg-white border-b shadow-sm flex-shrink-0 flex-wrap">
        <h1 className="text-lg font-bold text-gray-800">📄 Fatture</h1>
        <div className="flex-1" />

        {/* Stats badges */}
        <span className="text-xs px-2 py-1 bg-gray-100 rounded font-medium">{stats.total} fatture</span>
        <span className="text-xs px-2 py-1 bg-yellow-100 text-yellow-800 rounded font-medium">{stats.daPagare} da pagare</span>
        {stats.scadute > 0 && (
          <span className="text-xs px-2 py-1 bg-red-100 text-red-800 rounded font-medium">{stats.scadute} scadute</span>
        )}
        <span className="text-xs px-2 py-1 bg-green-100 text-green-800 rounded font-medium">{stats.pagate} pagate</span>
        <span className="text-xs px-2 py-1 bg-purple-100 text-purple-800 rounded font-medium">{stats.fornitori} fornitori</span>
        <span className="text-sm font-bold text-green-700">Totale: {fmtEur(stats.totalAmount)}</span>

        {/* Import button */}
        <button
          onClick={() => fileRef.current?.click()}
          className="px-3 py-1.5 text-xs font-semibold bg-sky-600 text-white rounded-lg hover:bg-sky-700"
        >
          📥 Importa
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".xml,.p7m,.zip"
          onChange={e => e.target.files && handleImport(e.target.files)}
          className="hidden"
        />
      </div>

      {/* Import progress */}
      {importing && (
        <div className="px-4 pt-3">
          <ImportProgress phase={importPhase} current={importCurrent} total={importTotal} logs={importLogs} />
        </div>
      )}

      {/* Main area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div className="w-80 border-r bg-white flex flex-col flex-shrink-0">
          {/* Search + filters */}
          <div className="p-2 border-b space-y-2">
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="🔍 Cerca fornitore, numero..."
              className="w-full px-2.5 py-1.5 text-xs border rounded-lg bg-gray-50 outline-none focus:ring-1 focus:ring-sky-400"
            />
            <div className="flex gap-1">
              {(['all', 'da_pagare', 'scaduta', 'pagata'] as const).map(s => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`flex-1 py-1 text-[10px] font-semibold rounded ${
                    statusFilter === s ? 'bg-sky-100 text-sky-700 border border-sky-300' : 'bg-gray-50 text-gray-500 border border-gray-200'
                  }`}
                >
                  {s === 'all' ? 'Tutte' : STATUS_LABELS[s]}
                </button>
              ))}
            </div>

            {/* Select mode controls */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setSelectMode(!selectMode);
                  if (selectMode) setChecked(new Set());
                }}
                className={`px-2 py-1 text-[10px] font-semibold rounded ${
                  selectMode ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {selectMode ? '✕ Esci Selezione' : '☐ Seleziona'}
              </button>

              {selectMode && (
                <>
                  <button onClick={selectAll} className="px-2 py-1 text-[10px] font-semibold bg-gray-100 text-gray-600 rounded hover:bg-gray-200">
                    {allFilteredChecked ? 'Deseleziona tutte' : 'Seleziona tutte'}
                  </button>
                  {checked.size > 0 && (
                    <button
                      onClick={() => setDeleteModal({ open: true, ids: Array.from(checked) })}
                      className="px-2 py-1 text-[10px] font-semibold bg-red-600 text-white rounded hover:bg-red-700"
                    >
                      🗑 Elimina {checked.size}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto">
            {loadingList ? (
              <div className="text-center py-8 text-gray-400 text-sm">Caricamento...</div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-8 text-gray-400 text-sm">
                {invoices.length === 0 ? 'Nessuna fattura importata' : 'Nessun risultato'}
              </div>
            ) : (
              filtered.map(inv => (
                <InvoiceCard
                  key={inv.id}
                  inv={inv}
                  selected={selectedId === inv.id}
                  checked={checked.has(inv.id)}
                  selectMode={selectMode}
                  onSelect={() => setSelectedId(inv.id)}
                  onCheck={() => toggleCheck(inv.id)}
                />
              ))
            )}
          </div>
        </div>

        {/* Detail */}
        <div className="flex-1 overflow-y-auto bg-gray-50">
          {selectedInvoice ? (
            <InvoiceDetail
              invoice={selectedInvoice}
              detail={detail}
              loadingDetail={loadingDetail}
              onEdit={handleEdit}
              onDelete={() => setDeleteModal({ open: true, ids: [selectedInvoice.id] })}
              onReload={reload}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">
              Seleziona una fattura dalla lista
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
