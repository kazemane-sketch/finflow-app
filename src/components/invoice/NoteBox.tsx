import { useState } from 'react';
import { fmtDate } from '@/lib/utils';

interface Props {
  lineId: string;
  note: string | null | undefined;
  noteSource: string | null | undefined;
  noteUpdatedAt: string | null | undefined;
  onSave: (note: string) => Promise<void>;
}

const SOURCE_LABELS: Record<string, string> = {
  user: 'Utente',
  ai_consultant: 'Consulente AI',
  ai_reviewer: 'AI',
};

/** Note card — Test Lab style */
export default function NoteBox({ lineId, note, noteSource, noteUpdatedAt, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note || '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(text);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border rounded-lg bg-white overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-b">
        <span className="text-sm font-bold text-slate-800">Note</span>
        {noteSource && (
          <span className="text-[10px] text-slate-400">
            {SOURCE_LABELS[noteSource] || noteSource}
            {noteUpdatedAt && ` \u2014 ${fmtDate(noteUpdatedAt)}`}
          </span>
        )}
      </div>
      <div className="px-3 py-2">
        {editing ? (
          <div>
            <textarea
              className="w-full text-[11px] border border-slate-200 rounded-lg p-2 min-h-[60px] focus:outline-none focus:ring-1 focus:ring-purple-300 resize-y text-slate-700"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Motivazione inerenza, decisione fiscale, note operative..."
              autoFocus
            />
            <div className="flex gap-1 mt-1.5">
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-2.5 py-1 text-[10px] font-semibold rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Salvo...' : 'Salva'}
              </button>
              <button
                onClick={() => { setEditing(false); setText(note || ''); }}
                className="px-2.5 py-1 text-[10px] font-semibold rounded border border-slate-200 text-slate-600 hover:bg-slate-50"
              >
                Annulla
              </button>
            </div>
          </div>
        ) : (
          <div
            className="text-[11px] text-slate-600 cursor-pointer hover:bg-slate-50/50 rounded p-1 min-h-[36px] transition-colors"
            onClick={() => setEditing(true)}
          >
            {note || <span className="italic text-slate-400">Clicca per aggiungere una nota...</span>}
          </div>
        )}
      </div>
    </div>
  );
}
