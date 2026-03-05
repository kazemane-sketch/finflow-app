// src/components/settings/ProjectsTab.tsx — Hierarchical tree CRUD for cost centers
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, Pencil, Trash2, X, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  loadProjects, createProject, updateProject, deleteProject,
  COLOR_PALETTE, PROJECT_STATUS_LABELS, PROJECT_STATUS_COLORS,
  type Project, type ProjectCreate, type ProjectStatus,
} from '@/lib/classificationService';

// ─── Tree helpers ────────────────────────────────────────

interface TreeNode extends Project {
  children: TreeNode[];
}

function buildProjectTree(projects: Project[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  // First pass: create tree nodes
  for (const p of projects) {
    byId.set(p.id, { ...p, children: [] });
  }

  // Second pass: nest children under parents
  for (const p of projects) {
    const node = byId.get(p.id)!;
    if (p.parent_id && byId.has(p.parent_id)) {
      byId.get(p.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort children by sort_order
  for (const node of byId.values()) {
    node.children.sort((a, b) => a.sort_order - b.sort_order);
  }

  return roots.sort((a, b) => a.sort_order - b.sort_order);
}

// ─── Tree Row (recursive) ────────────────────────────────

function ProjectTreeRow({ node, depth, collapsed, onToggle, onEdit, onDelete }: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onEdit: (p: Project) => void;
  onDelete: (p: Project) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(node.id);
  const isParent = hasChildren || !node.parent_id;

  return (
    <>
      <div
        className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors ${
          isParent && hasChildren
            ? 'bg-gray-50 border-gray-200 hover:bg-gray-100'
            : 'bg-white border-gray-100 hover:bg-gray-50'
        }`}
        style={{ marginLeft: depth * 24 }}
      >
        {/* Toggle button for parents with children */}
        {hasChildren ? (
          <button
            onClick={() => onToggle(node.id)}
            className="p-0.5 text-gray-400 hover:text-gray-700 transition-colors"
          >
            {isCollapsed
              ? <ChevronRight className="h-3.5 w-3.5" />
              : <ChevronDown className="h-3.5 w-3.5" />
            }
          </button>
        ) : (
          <span className="w-[18px]" /> // spacer
        )}

        {/* Color dot */}
        <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: node.color }} />

        {/* Code */}
        <span className={`text-xs font-mono font-bold min-w-[80px] ${
          isParent && hasChildren ? 'text-gray-700' : 'text-sky-700'
        }`}>
          {node.code}
        </span>

        {/* Name + description */}
        <div className="flex-1 min-w-0">
          <span className={`text-sm ${isParent && hasChildren ? 'font-semibold text-gray-800' : 'font-medium text-gray-700'}`}>
            {node.name}
          </span>
          {node.description && (
            <span className="text-[10px] text-gray-400 ml-2 truncate">{node.description}</span>
          )}
        </div>

        {/* Status badge */}
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${PROJECT_STATUS_COLORS[node.status]}`}>
          {PROJECT_STATUS_LABELS[node.status]}
        </span>

        {/* Edit/Delete buttons */}
        <button
          onClick={() => onEdit(node)}
          className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-200 rounded-md transition-colors"
          title="Modifica"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => onDelete(node)}
          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
          title="Elimina"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Render children if not collapsed */}
      {hasChildren && !isCollapsed && node.children.map(child => (
        <ProjectTreeRow
          key={child.id}
          node={child}
          depth={depth + 1}
          collapsed={collapsed}
          onToggle={onToggle}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </>
  );
}

// ─── Main Component ──────────────────────────────────────

export default function ProjectsTab({ companyId }: { companyId: string }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<{ proj?: Project } | null>(null);
  const [delModal, setDelModal] = useState<Project | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    setLoading(true);
    try { setProjects(await loadProjects(companyId)); }
    catch (e: any) { console.error(e); }
    setLoading(false);
  }, [companyId]);

  useEffect(() => { reload(); }, [reload]);

  const tree = useMemo(() => buildProjectTree(projects), [projects]);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleDelete = async () => {
    if (!delModal) return;
    try { await deleteProject(delModal.id); await reload(); }
    catch (e: any) { alert('Errore: ' + e.message); }
    setDelModal(null);
  };

  // Available parents for the form (level 1 = no parent_id)
  const availableParents = useMemo(() =>
    projects.filter(p => !p.parent_id),
  [projects]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">Centri di Costo</h2>
        <Button size="sm" variant="outline" onClick={() => setModal({})}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />Nuovo centro di costo
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400 text-center py-6">Caricamento...</p>
      ) : tree.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-6">Nessun centro di costo configurato</p>
      ) : (
        <div className="space-y-1">
          {tree.map(node => (
            <ProjectTreeRow
              key={node.id}
              node={node}
              depth={0}
              collapsed={collapsed}
              onToggle={toggleCollapse}
              onEdit={(p) => setModal({ proj: p })}
              onDelete={(p) => setDelModal(p)}
            />
          ))}
        </div>
      )}

      {/* Create/Edit modal */}
      {modal && (
        <ProjectFormModal
          project={modal.proj}
          companyId={companyId}
          availableParents={availableParents}
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
                <p className="font-semibold text-gray-900">Elimina centro di costo</p>
                <p className="text-sm text-gray-500">
                  Eliminare <strong>{delModal.code} — {delModal.name}</strong>?
                  {projects.some(p => p.parent_id === delModal.id) && (
                    <span className="block text-red-500 text-xs mt-1">
                      Attenzione: questo centro ha dei sotto-centri che perderanno il padre.
                    </span>
                  )}
                </p>
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

// ─── Form Modal ────────────────────────────────────────────

function ProjectFormModal({ project, companyId, availableParents, onSave, onClose }: {
  project?: Project;
  companyId: string;
  availableParents: Project[];
  onSave: () => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<ProjectCreate>({
    code: project?.code || '',
    name: project?.name || '',
    description: project?.description || '',
    color: project?.color || '#10b981',
    status: project?.status || 'active',
    start_date: project?.start_date || null,
    end_date: project?.end_date || null,
    budget: project?.budget ?? null,
    parent_id: project?.parent_id || null,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    if (!form.code.trim()) { setError('Il codice e obbligatorio'); return; }
    if (!form.name.trim()) { setError('Il nome e obbligatorio'); return; }
    setSaving(true);
    setError('');
    try {
      if (project?.id) {
        await updateProject(project.id, form);
      } else {
        await createProject(companyId, form);
      }
      onSave();
    } catch (e: any) {
      setError(e.message || 'Errore');
    }
    setSaving(false);
  };

  // Don't show current project as available parent (can't be its own parent)
  const parentOptions = availableParents.filter(p => p.id !== project?.id);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-900">
            {project ? 'Modifica centro di costo' : 'Nuovo centro di costo'}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Codice *</Label>
              <Input value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value.toUpperCase() }))}
                placeholder="BRE-CAV" className="mt-1 font-mono" />
            </div>
            <div>
              <Label className="text-xs">Stato</Label>
              <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as ProjectStatus }))}
                className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white focus:ring-2 focus:ring-sky-500 outline-none">
                <option value="active">Attivo</option>
                <option value="completed">Completato</option>
                <option value="suspended">Sospeso</option>
              </select>
            </div>
          </div>
          <div>
            <Label className="text-xs">Nome *</Label>
            <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Brescia Cava (estrazione calcare)" className="mt-1" />
          </div>
          <div>
            <Label className="text-xs">Centro padre</Label>
            <select
              value={form.parent_id || ''}
              onChange={e => setForm(f => ({ ...f, parent_id: e.target.value || null }))}
              className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white focus:ring-2 focus:ring-sky-500 outline-none"
            >
              <option value="">— Nessuno (livello 1) —</option>
              {parentOptions.map(p => (
                <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
              ))}
            </select>
            <p className="text-[10px] text-gray-400 mt-1">Seleziona un centro padre per creare un sotto-centro</p>
          </div>
          <div>
            <Label className="text-xs">Descrizione</Label>
            <Input value={form.description || ''} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Opzionale" className="mt-1" />
          </div>
          <div>
            <Label className="text-xs">Colore</Label>
            <div className="flex flex-wrap gap-2 mt-1.5">
              {COLOR_PALETTE.map(c => (
                <button key={c} onClick={() => setForm(f => ({ ...f, color: c }))}
                  className={`w-7 h-7 rounded-full border-2 transition-all ${form.color === c ? 'border-gray-900 scale-110 ring-2 ring-offset-1 ring-gray-400' : 'border-transparent hover:scale-105'}`}
                  style={{ backgroundColor: c }} />
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Data inizio</Label>
              <Input type="date" value={form.start_date || ''} onChange={e => setForm(f => ({ ...f, start_date: e.target.value || null }))}
                className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Data fine</Label>
              <Input type="date" value={form.end_date || ''} onChange={e => setForm(f => ({ ...f, end_date: e.target.value || null }))}
                className="mt-1" />
            </div>
          </div>
          <div>
            <Label className="text-xs">Budget</Label>
            <Input type="number" step="0.01" value={form.budget ?? ''} onChange={e => setForm(f => ({ ...f, budget: e.target.value ? Number(e.target.value) : null }))}
              placeholder="Opzionale" className="mt-1" />
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
        <div className="flex gap-2 justify-end mt-5">
          <Button variant="outline" onClick={onClose}>Annulla</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Salvataggio...' : project ? 'Aggiorna' : 'Crea'}
          </Button>
        </div>
      </div>
    </div>
  );
}
