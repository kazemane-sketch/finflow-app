// src/components/settings/ChartOfAccountsTab.tsx — Tree CRUD for chart of accounts
// with onboarding wizard (sector template selection) + PDF import
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, Pencil, Trash2, X, AlertTriangle, ChevronDown, ChevronRight, FileText, Loader2, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  loadChartOfAccounts, createChartAccount, updateChartAccount, deleteChartAccount,
  SECTION_LABELS,
  type ChartAccount, type ChartAccountCreate, type CoaSection,
} from '@/lib/classificationService';
import {
  loadTemplateSectors, applyTemplate,
  type CoaSector, type SectorMeta,
} from '@/lib/coaTemplateService';
import ImportCOADialog from '@/components/settings/ImportCOADialog';

// ─── Tree helpers ─────────────────────────────────────────

interface TreeNode extends ChartAccount {
  children: TreeNode[];
}

function buildTree(accounts: ChartAccount[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const byCode = new Map<string, TreeNode>();

  for (const acc of accounts) {
    byCode.set(acc.code, { ...acc, children: [] });
  }

  for (const acc of accounts) {
    const node = byCode.get(acc.code)!;
    if (acc.parent_code && byCode.has(acc.parent_code)) {
      byCode.get(acc.parent_code)!.children.push(node);
    } else if (acc.level === 1) {
      roots.push(node);
    } else {
      let found = false;
      for (const [code, parent] of byCode) {
        if (code !== acc.code && acc.code.startsWith(code) && parent.level < acc.level) {
          parent.children.push(node);
          found = true;
          break;
        }
      }
      if (!found) roots.push(node);
    }
  }

  return roots;
}

// ─── Section badge color ──────────────────────────────────

const SECTION_COLORS: Partial<Record<CoaSection, string>> = {
  revenue: 'bg-emerald-100 text-emerald-700',
  cost_production: 'bg-red-100 text-red-700',
  cost_personnel: 'bg-orange-100 text-orange-700',
  depreciation: 'bg-amber-100 text-amber-700',
  other_costs: 'bg-gray-100 text-gray-600',
  financial: 'bg-blue-100 text-blue-700',
  assets: 'bg-sky-100 text-sky-700',
  liabilities: 'bg-pink-100 text-pink-700',
  equity: 'bg-violet-100 text-violet-700',
  extraordinary: 'bg-purple-100 text-purple-700',
};

// ─── Tree Row ─────────────────────────────────────────────

function TreeRow({ node, depth, collapsed, onToggle, onEdit, onDelete }: {
  node: TreeNode; depth: number; collapsed: Set<string>;
  onToggle: (code: string) => void;
  onEdit: (acc: ChartAccount) => void; onDelete: (acc: ChartAccount) => void;
}) {
  const isOpen = !collapsed.has(node.code);
  const hasChildren = node.children.length > 0;
  const indent = depth * 20;

  return (
    <>
      <div className={`flex items-center gap-1.5 px-2 py-1.5 hover:bg-gray-50 border-b border-gray-50 ${node.is_header ? 'bg-gray-50' : ''}`}
        style={{ paddingLeft: indent + 8 }}>
        {hasChildren ? (
          <button onClick={() => onToggle(node.code)} className="p-0.5 text-gray-400 hover:text-gray-700">
            {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <span className="w-[18px]" />
        )}
        <span className={`font-mono text-[11px] min-w-[60px] ${node.is_header ? 'text-gray-900 font-bold' : 'text-sky-700 font-semibold'}`}>
          {node.code}
        </span>
        <span className="text-[1px] text-gray-300 mx-0.5">|</span>
        <span className={`text-xs flex-1 ${node.is_header ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>
          {node.name}
        </span>
        {depth === 0 && (
          <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${SECTION_COLORS[node.section] || 'bg-gray-100 text-gray-600'}`}>
            {SECTION_LABELS[node.section]}
          </span>
        )}
        <button onClick={() => onEdit(node)} className="p-1 text-gray-300 hover:text-gray-700 hover:bg-gray-200 rounded transition-colors opacity-0 group-hover:opacity-100"
          style={{ opacity: undefined }}>
          <Pencil className="h-3 w-3" />
        </button>
        <button onClick={() => onDelete(node)} className="p-1 text-gray-300 hover:text-red-600 hover:bg-red-50 rounded transition-colors">
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      {isOpen && node.children.map(child => (
        <TreeRow key={child.id} node={child} depth={depth + 1} collapsed={collapsed}
          onToggle={onToggle} onEdit={onEdit} onDelete={onDelete} />
      ))}
    </>
  );
}

// ─── Setup Wizard ─────────────────────────────────────────

function CoaSetupWizard({ companyId, onComplete }: {
  companyId: string;
  onComplete: () => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [sectors, setSectors] = useState<SectorMeta[]>([]);
  const [selectedSector, setSelectedSector] = useState<CoaSector | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [appliedCount, setAppliedCount] = useState(0);
  const [error, setError] = useState('');
  const [showImportDialog, setShowImportDialog] = useState(false);

  // Load sector metadata
  useEffect(() => {
    loadTemplateSectors()
      .then(setSectors)
      .catch(e => console.error('Failed to load sectors:', e))
      .finally(() => setLoading(false));
  }, []);

  const handleSelectSector = (sector: CoaSector) => {
    setSelectedSector(sector);
    setStep(2);
  };

  const handleApply = async () => {
    if (!selectedSector) return;
    setApplying(true);
    setError('');
    try {
      const count = await applyTemplate(companyId, selectedSector);
      setAppliedCount(count);
      setStep(3);
    } catch (e: any) {
      setError(e.message || 'Errore durante l\'applicazione del template');
    }
    setApplying(false);
  };

  const selectedMeta = sectors.find(s => s.sector === selectedSector);

  if (loading) {
    return (
      <div className="text-center py-8">
        <Loader2 className="h-6 w-6 text-gray-400 animate-spin mx-auto" />
        <p className="text-sm text-gray-400 mt-2">Caricamento template...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ─── Step 1: Sector selection ─── */}
      {step === 1 && (
        <div className="space-y-4">
          <div className="text-center space-y-1">
            <p className="text-sm font-medium text-gray-900">Seleziona il settore della tua azienda</p>
            <p className="text-xs text-gray-500">
              Verrà caricato un piano dei conti standard per il tuo settore
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {sectors.map(s => (
              <button
                key={s.sector}
                onClick={() => handleSelectSector(s.sector)}
                className="text-left p-4 border-2 border-gray-200 rounded-xl hover:border-sky-400
                  hover:bg-sky-50/50 transition-all group cursor-pointer"
              >
                <div className="text-2xl mb-2">{s.icon}</div>
                <p className="text-sm font-semibold text-gray-900 group-hover:text-sky-700">{s.label}</p>
                <p className="text-xs text-gray-500 mt-0.5">{s.description}</p>
                <p className="text-[10px] text-gray-400 mt-2">~{s.accountCount} conti</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ─── Step 2: Confirm & Apply ─── */}
      {step === 2 && selectedMeta && (
        <div className="text-center space-y-4 py-4">
          <div className="text-3xl">{selectedMeta.icon}</div>
          <div>
            <p className="text-sm font-semibold text-gray-900">{selectedMeta.label}</p>
            <p className="text-xs text-gray-500">{selectedMeta.description}</p>
          </div>
          <p className="text-sm text-gray-600">
            Verranno creati <span className="font-semibold text-sky-700">~{selectedMeta.accountCount} conti</span> nel piano dei conti
          </p>
          {error && (
            <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
          )}
          <div className="flex justify-center gap-3">
            <Button variant="outline" size="sm" onClick={() => { setStep(1); setError(''); }}>
              Indietro
            </Button>
            <Button size="sm" onClick={handleApply} disabled={applying}>
              {applying ? (
                <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Applicazione...</>
              ) : (
                <>Applica template ({selectedMeta.accountCount} conti)</>
              )}
            </Button>
          </div>
        </div>
      )}

      {/* ─── Step 3: Success + optional PDF import ─── */}
      {step === 3 && (
        <div className="text-center space-y-4 py-4">
          <CheckCircle className="h-10 w-10 text-emerald-500 mx-auto" />
          <div>
            <p className="text-sm font-semibold text-gray-900">
              Template applicato con successo!
            </p>
            <p className="text-xs text-gray-500 mt-1">
              {appliedCount} conti importati nel piano dei conti
            </p>
          </div>

          <div className="bg-gray-50 rounded-xl p-4 space-y-2 max-w-sm mx-auto">
            <p className="text-xs text-gray-600">
              Vuoi personalizzare il piano dei conti caricando il bilancio della tua azienda?
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowImportDialog(true)}
              className="w-full"
            >
              <FileText className="h-3.5 w-3.5 mr-1.5" />
              Importa da bilancio PDF
            </Button>
          </div>

          <Button size="sm" onClick={onComplete}>
            Chiudi e visualizza piano dei conti
          </Button>

          {showImportDialog && (
            <ImportCOADialog
              companyId={companyId}
              existingCodes={new Set()} // will be populated after reload
              open={showImportDialog}
              onClose={() => setShowImportDialog(false)}
              onImported={() => { setShowImportDialog(false); onComplete(); }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────

export default function ChartOfAccountsTab({ companyId }: { companyId: string }) {
  const [accounts, setAccounts] = useState<ChartAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<{ acc?: ChartAccount } | null>(null);
  const [delModal, setDelModal] = useState<ChartAccount | null>(null);
  const [showImportDialog, setShowImportDialog] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try { setAccounts(await loadChartOfAccounts(companyId)); }
    catch (e: any) { console.error(e); }
    setLoading(false);
  }, [companyId]);

  useEffect(() => { reload(); }, [reload]);

  const tree = useMemo(() => buildTree(accounts), [accounts]);

  const existingCodes = useMemo(
    () => new Set(accounts.map(a => a.code)),
    [accounts]
  );

  const toggleCollapse = (code: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  };

  const handleDelete = async () => {
    if (!delModal) return;
    try { await deleteChartAccount(delModal.id); await reload(); }
    catch (e: any) { alert('Errore: ' + e.message); }
    setDelModal(null);
  };

  // Show wizard if the chart is empty (or nearly empty)
  const showWizard = !loading && accounts.length < 5;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">Piano dei Conti</h2>
        {!showWizard && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setShowImportDialog(true)}>
              <FileText className="h-3.5 w-3.5 mr-1.5" />Importa da bilancio PDF
            </Button>
            <Button size="sm" variant="outline" onClick={() => setModal({})}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />Nuovo conto
            </Button>
          </div>
        )}
      </div>

      {/* Loading */}
      {loading && (
        <p className="text-sm text-gray-400 text-center py-6">Caricamento...</p>
      )}

      {/* Wizard (when chart is empty) */}
      {showWizard && (
        <CoaSetupWizard companyId={companyId} onComplete={reload} />
      )}

      {/* Tree view (when chart has accounts) */}
      {!loading && accounts.length >= 5 && (
        <>
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            {tree.map(node => (
              <TreeRow key={node.id} node={node} depth={0} collapsed={collapsed}
                onToggle={toggleCollapse} onEdit={acc => setModal({ acc })} onDelete={acc => setDelModal(acc)} />
            ))}
          </div>

          {/* Count */}
          <p className="text-xs text-gray-400 text-right">{accounts.length} conti totali</p>
        </>
      )}

      {/* Import dialog */}
      {showImportDialog && (
        <ImportCOADialog
          companyId={companyId}
          existingCodes={existingCodes}
          open={showImportDialog}
          onClose={() => setShowImportDialog(false)}
          onImported={() => { setShowImportDialog(false); reload(); }}
        />
      )}

      {/* Create/Edit modal */}
      {modal && (
        <AccountFormModal
          account={modal.acc}
          companyId={companyId}
          accounts={accounts}
          onSave={() => { reload(); setModal(null); }}
          onClose={() => setModal(null)}
        />
      )}

      {/* Delete confirm */}
      {delModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100">
                <AlertTriangle className="h-5 w-5 text-red-600" />
              </div>
              <div>
                <p className="font-semibold text-gray-900">Elimina conto</p>
                <p className="text-sm text-gray-500">Eliminare <strong>{delModal.code} — {delModal.name}</strong>?</p>
              </div>
            </div>
            <div className="flex gap-3 justify-end">
              <Button variant="outline" onClick={() => setDelModal(null)}>Annulla</Button>
              <Button variant="destructive" onClick={handleDelete}><Trash2 className="h-3.5 w-3.5 mr-1.5" />Elimina</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Account Form Modal ───────────────────────────────────

const ALL_SECTIONS: CoaSection[] = [
  'assets', 'liabilities', 'equity', 'revenue',
  'cost_production', 'cost_personnel', 'depreciation',
  'other_costs', 'financial', 'extraordinary',
];

function AccountFormModal({ account, companyId, accounts, onSave, onClose }: {
  account?: ChartAccount; companyId: string; accounts: ChartAccount[];
  onSave: () => void; onClose: () => void;
}) {
  const [form, setForm] = useState<ChartAccountCreate>({
    code: account?.code || '',
    name: account?.name || '',
    section: account?.section || 'cost_production',
    parent_code: account?.parent_code || null,
    level: account?.level || 2,
    is_header: account?.is_header || false,
  });
  const [active, setActive] = useState(account?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const parentOptions = accounts.filter(a => a.level < (form.level || 2) && a.id !== account?.id);

  const handleSave = async () => {
    if (!form.code.trim()) { setError('Il codice e obbligatorio'); return; }
    if (!form.name.trim()) { setError('Il nome e obbligatorio'); return; }
    setSaving(true);
    setError('');
    try {
      if (account?.id) {
        await updateChartAccount(account.id, { ...form, active }, companyId);
      } else {
        await createChartAccount(companyId, form);
      }
      onSave();
    } catch (e: any) {
      setError(e.message || 'Errore');
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-900">{account ? 'Modifica conto' : 'Nuovo conto'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Codice *</Label>
              <Input value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value }))}
                placeholder="60812" className="mt-1 font-mono" />
            </div>
            <div>
              <Label className="text-xs">Livello</Label>
              <select value={form.level} onChange={e => setForm(f => ({ ...f, level: Number(e.target.value) }))}
                className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white focus:ring-2 focus:ring-sky-500 outline-none">
                <option value={1}>1 — Principale</option>
                <option value={2}>2 — Sottoconto</option>
                <option value={3}>3 — Dettaglio</option>
              </select>
            </div>
          </div>
          <div>
            <Label className="text-xs">Nome *</Label>
            <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Carburanti e lubrificanti 100%" className="mt-1" />
          </div>
          <div>
            <Label className="text-xs">Sezione *</Label>
            <select value={form.section} onChange={e => setForm(f => ({ ...f, section: e.target.value as CoaSection }))}
              className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white focus:ring-2 focus:ring-sky-500 outline-none">
              {ALL_SECTIONS.map(s => (
                <option key={s} value={s}>{SECTION_LABELS[s]}</option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-xs">Conto padre</Label>
            <select value={form.parent_code || ''} onChange={e => setForm(f => ({ ...f, parent_code: e.target.value || null }))}
              className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white focus:ring-2 focus:ring-sky-500 outline-none">
              <option value="">— Nessuno (radice) —</option>
              {parentOptions.map(a => (
                <option key={a.id} value={a.code}>{a.code} — {a.name}</option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.is_header} onChange={e => setForm(f => ({ ...f, is_header: e.target.checked }))}
              className="rounded border-gray-300" />
            <span className="text-xs text-gray-700">Intestazione di gruppo (non usabile per registrazioni)</span>
          </label>
          {account && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)}
                className="rounded border-gray-300" />
              <span className="text-xs text-gray-700">Attivo</span>
            </label>
          )}
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
        <div className="flex gap-2 justify-end mt-5">
          <Button variant="outline" onClick={onClose}>Annulla</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Salvataggio...' : account ? 'Aggiorna' : 'Crea'}
          </Button>
        </div>
      </div>
    </div>
  );
}
