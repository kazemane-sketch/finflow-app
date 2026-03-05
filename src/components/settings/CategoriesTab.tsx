// src/components/settings/CategoriesTab.tsx — CRUD for expense/revenue categories
import { useState, useEffect, useCallback } from 'react';
import { Plus, Pencil, Trash2, X, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  loadCategories, createCategory, updateCategory, deleteCategory,
  COLOR_PALETTE, CATEGORY_TYPE_LABELS,
  type Category, type CategoryCreate, type CategoryType,
} from '@/lib/classificationService';

export default function CategoriesTab({ companyId }: { companyId: string }) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<{ cat?: Category } | null>(null);
  const [delModal, setDelModal] = useState<Category | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try { setCategories(await loadCategories(companyId)); }
    catch (e: any) { console.error(e); }
    setLoading(false);
  }, [companyId]);

  useEffect(() => { reload(); }, [reload]);

  const handleDelete = async () => {
    if (!delModal) return;
    try { await deleteCategory(delModal.id); await reload(); }
    catch (e: any) { alert('Errore: ' + e.message); }
    setDelModal(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">Categorie</h2>
        <Button size="sm" variant="outline" onClick={() => setModal({})}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />Nuova categoria
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400 text-center py-6">Caricamento...</p>
      ) : categories.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-6">Nessuna categoria configurata</p>
      ) : (
        <div className="space-y-1.5">
          {categories.map(c => (
            <div key={c.id} className="flex items-center gap-3 px-3 py-2.5 bg-gray-50 rounded-lg border border-gray-100 hover:bg-gray-100 transition-colors">
              <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: c.color }} />
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-gray-900">{c.name}</span>
                {c.description && <span className="text-xs text-gray-400 ml-2">{c.description}</span>}
              </div>
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                c.type === 'revenue' ? 'bg-emerald-100 text-emerald-700' :
                c.type === 'expense' ? 'bg-red-100 text-red-700' :
                'bg-purple-100 text-purple-700'
              }`}>{CATEGORY_TYPE_LABELS[c.type]}</span>
              {!c.active && <span className="text-[10px] font-medium text-gray-400 bg-gray-200 px-1.5 py-0.5 rounded">Inattiva</span>}
              <button onClick={() => setModal({ cat: c })} className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-200 rounded-md transition-colors">
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button onClick={() => setDelModal(c)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Create/Edit modal */}
      {modal && (
        <CategoryFormModal
          category={modal.cat}
          companyId={companyId}
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
                <p className="font-semibold text-gray-900">Elimina categoria</p>
                <p className="text-sm text-gray-500">Eliminare <strong>{delModal.name}</strong>?</p>
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

function CategoryFormModal({ category, companyId, onSave, onClose }: {
  category?: Category; companyId: string; onSave: () => void; onClose: () => void;
}) {
  const [form, setForm] = useState<CategoryCreate>({
    name: category?.name || '',
    type: category?.type || 'expense',
    color: category?.color || '#6366f1',
    description: category?.description || '',
  });
  const [active, setActive] = useState(category?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    if (!form.name.trim()) { setError('Il nome e obbligatorio'); return; }
    setSaving(true);
    setError('');
    try {
      if (category?.id) {
        await updateCategory(category.id, { ...form, active });
      } else {
        await createCategory(companyId, form);
      }
      onSave();
    } catch (e: any) {
      setError(e.message || 'Errore');
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full mx-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-900">{category ? 'Modifica categoria' : 'Nuova categoria'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Nome *</Label>
            <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Es. Vendita calcare" className="mt-1" />
          </div>
          <div>
            <Label className="text-xs">Tipo *</Label>
            <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as CategoryType }))}
              className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white focus:ring-2 focus:ring-sky-500 outline-none">
              <option value="revenue">Ricavo</option>
              <option value="expense">Costo</option>
              <option value="both">Entrambi</option>
            </select>
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
          <div>
            <Label className="text-xs">Descrizione</Label>
            <Input value={form.description || ''} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Opzionale" className="mt-1" />
          </div>
          {category && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)}
                className="rounded border-gray-300" />
              <span className="text-xs text-gray-700">Attiva</span>
            </label>
          )}
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
        <div className="flex gap-2 justify-end mt-5">
          <Button variant="outline" onClick={onClose}>Annulla</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Salvataggio...' : category ? 'Aggiorna' : 'Crea'}
          </Button>
        </div>
      </div>
    </div>
  );
}
