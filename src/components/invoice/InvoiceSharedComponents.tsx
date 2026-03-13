import React, { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { MP } from '@/lib/invoiceParser';
import { verifyPassword, type DBInvoice, type InvoiceUpdate, type InvoiceClassificationMeta } from '@/lib/invoiceSaver';
import { fmtEur, fmtDate } from '@/lib/utils';
import { ReconciledIcon, ReconciliationDot } from '@/components/ReconciliationIndicators';
import type { AIJob } from '@/stores/useAIJobStore';
import type { ArticleWithPhases, ArticlePhase, MatchResult } from '@/lib/articlesService';
import type { PipelineStepDebug } from '@/lib/classificationPipelineService';
import type { LineDetailData } from '@/lib/classificationService';

export const STATUS_LABELS: Record<string, string> = { pending: 'Da Pagare', overdue: 'Scaduta', paid: 'Pagata' };
export const getStatusLabel = (status: string, direction?: string) => {
  if (status === 'pending') return direction === 'out' ? 'Da Incassare' : 'Da Pagare';
  return STATUS_LABELS[status] || status;
};
export const STATUS_COLORS: Record<string, string> = { pending: 'bg-yellow-100 text-yellow-800', overdue: 'bg-red-100 text-red-800', paid: 'bg-green-100 text-green-800' };

export function Sec({ title, children, open: dO = true }: { title: string; children: React.ReactNode; open?: boolean }) {
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

export function Row({ l, v, accent, bold }: { l: string; v?: string | null; accent?: boolean; bold?: boolean }) {
  if (!v) return null;
  return (<div className="flex justify-between items-baseline py-0.5 border-b border-gray-100">
    <span className="text-gray-500 text-xs min-w-[120px]">{l}</span>
    <span className={`text-xs text-right max-w-[64%] break-words ${accent ? 'text-sky-700 font-bold' : bold ? 'font-bold' : ''}`}>{v}</span>
  </div>);
}

export function getFinalReasoningSummary(detail?: LineDetailData | null): string | null {
  if (!detail) return null;
  return detail.reasoning_summary_final || detail.fiscal_reasoning || detail.classification_reasoning || null;
}

export function getPendingDecisionReason(detail?: LineDetailData | null): string | null {
  if (!detail?.decision_status) return null;
  if (detail.decision_status === 'needs_review') return 'Non deciso: serve revisione manuale';
  if (detail.decision_status === 'unassigned') return 'Non deciso: evidenza insufficiente';
  if (detail.decision_status === 'pending') return 'Decisione in consolidamento';
  return null;
}

export function ConfirmDeleteModal({ open, count, onConfirm, onCancel }: { open: boolean; count: number; onConfirm: (pw: string) => void; onCancel: () => void }) {
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

export function EditForm({ invoice, onSave, onCancel }: { invoice: DBInvoice; onSave: (u: InvoiceUpdate) => Promise<void>; onCancel: () => void }) {
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

export interface ImportLog { fn: string; status: 'ok' | 'duplicate' | 'error_parse' | 'error_save'; message?: string | null; }
export function ImportProgress({ phase, current, total, logs }: { phase: 'reading' | 'saving' | 'done'; current: number; total: number; logs: ImportLog[] }) {
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

export function ReviewBadge({ confidence, hasNote, needsReview }: { confidence?: number; hasNote?: boolean; needsReview?: boolean; }) {
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

export function PipelineStepDetailPanel({ step }: { step: PipelineStepDebug }) {
  const stepLabels: Record<string, string> = {
    deterministic: '\uD83D\uDD0D Step 1: Regole + Storico',
    understand: '\uD83E\uDDE0 Step 2: Comprensione (legacy)',
    classify: '\uD83E\uDDE0 Step 2: Commercialista',
    commercialista: '\uD83E\uDDE0 Step 2: Commercialista',
    cdc: '\uD83C\uDFE2 Step 3: Centri di Costo',
    reviewer: '\u2696\uFE0F Step 4: Revisore Fiscale',
    consultant: '\uD83D\uDCAC Step 5: Consulente Inline',
    persist: '\uD83D\uDCBE Step 6: Persistenza',
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

        {step.extra && Object.keys(step.extra).length > 0 && (
          <div>
            <div className="font-semibold text-slate-500 mb-1">Dati aggiuntivi:</div>
            <pre className="text-[10px] bg-slate-50 p-2 rounded overflow-x-auto max-h-32 overflow-y-auto">
              {JSON.stringify(step.extra, null, 2)}
            </pre>
          </div>
        )}

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

export function SingleInvoiceAIProgressCard({ job, onStop }: { job: AIJob; onStop: () => void }) {
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

export function InvoiceCard({ inv, selected, checked, selectMode, onSelect, onCheck, onPrefetch, isMatched, suggestionScore, meta, rowRef }: { inv: DBInvoice; selected: boolean; checked: boolean; selectMode: boolean; onSelect: () => void; onCheck: () => void; onPrefetch?: () => void; isMatched?: boolean; suggestionScore?: number; meta?: InvoiceClassificationMeta; rowRef?: (node: HTMLDivElement | null) => void }) {
  const nc = inv.doc_type === 'TD04' || inv.doc_type === 'TD05';
  const cp = (inv.counterparty || {}) as any;
  const displayName = cp?.denom || inv.source_filename || 'Sconosciuto';
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      className={`flex items-start gap-3 px-3.5 py-3 cursor-pointer transition-all duration-200 mx-2 my-1.5 rounded-xl border ${
        checked 
          ? 'bg-blue-50/80 border-blue-400 shadow-sm ring-2 ring-blue-500/20' 
          : selected 
            ? 'bg-indigo-50/60 border-indigo-300 shadow-md ring-4 ring-indigo-500/10 scale-[1.02] z-10' 
            : 'bg-white border-transparent shadow-sm hover:shadow hover:scale-[1.01] hover:border-slate-200 relative'
      }`}
    >
      {selectMode && <input type="checkbox" checked={checked} onChange={onCheck} className="mt-1 accent-blue-600 cursor-pointer flex-shrink-0" onClick={e => e.stopPropagation()} />}
      <div className="flex-1 min-w-0" onClick={onSelect}>
        <div className="flex justify-between items-center">
          <span className="text-xs font-semibold text-gray-800 truncate max-w-[55%]">{displayName}</span>
          <span className="text-xs font-bold text-slate-900">{fmtEur(inv.total_amount)}</span>
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
        <div className="flex items-center gap-1 mt-1 flex-wrap">
          {hasAnyField && meta ? (
            <>
              {meta.lines_with_category > 0 && (meta.has_category
                ? <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 border border-slate-200">Cat</span>
                : <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 border border-amber-200">!Cat</span>)}
              {meta.lines_with_cdc > 0 && (meta.has_cost_center
                ? <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 border border-slate-200">CdC</span>
                : <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 border border-amber-200">!CdC</span>)}
              {meta.lines_with_account > 0 && (meta.has_account
                ? <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 border border-slate-200">Conto</span>
                : <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 border border-amber-200">!Conto</span>)}
              {meta.lines_with_article > 0 && (meta.has_article
                ? <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 border border-slate-200">Art</span>
                : <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 border border-amber-200">!Art</span>)}
            </>
          ) : inv.classification_status === 'ai_suggested' ? (
            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 flex items-center gap-0.5">&#9889; Da confermare</span>
          ) : needsClassification ? (
            <span className="text-[9px] font-medium text-amber-600 flex items-center gap-0.5">↳ Da classificare</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export interface LineArticleInfo {
  article_id: string; code: string; name: string;
  assigned_by: string; verified: boolean; location: string | null;
  phase_id: string | null; phase_code: string | null; phase_name: string | null;
}

export function ArticleDropdown({ articles, current, suggestion, onAssign, onRemove, onDismissSuggestion }: {
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

  useEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const dropH = 240; 
    const spaceBelow = window.innerHeight - rect.bottom;
    const dropUp = spaceBelow < dropH && rect.top > dropH;
    setPos({
      top: dropUp ? rect.top - 4 : rect.bottom + 4,
      left: Math.max(8, rect.right - 256), 
      dropUp,
    });
  }, [open]);

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

export function PhaseDropdown({ phases, currentPhaseId, onSelect }: {
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
