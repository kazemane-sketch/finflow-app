import { useState } from 'react';
import ConfidenceBadge from './ConfidenceBadge';

interface Props {
  icon: string;
  title: string;
  confidence: number | null | undefined;
  reasoning: string | null | undefined;
  thinking: string | null | undefined;
  variant: 'blue' | 'purple';
}

/** Reasoning card — Test Lab style */
export default function ReasoningBox({ icon, title, confidence, reasoning, thinking, variant }: Props) {
  const [showThinking, setShowThinking] = useState(false);

  // variant tints the icon only, card itself is neutral
  const iconColor = variant === 'blue' ? 'text-blue-500' : 'text-purple-500';

  return (
    <div className="border rounded-lg bg-white overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-b">
        <span className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
          <span className={iconColor}>{icon}</span> {title}
        </span>
        <ConfidenceBadge value={confidence} />
      </div>
      <div className="px-3 py-2 text-[11px] text-slate-600 leading-relaxed">
        {reasoning || <span className="italic text-slate-400">Nessun reasoning disponibile</span>}
      </div>
      {thinking && (
        <>
          <button
            onClick={() => setShowThinking(!showThinking)}
            className="w-full px-3 py-1.5 text-[10px] text-slate-400 hover:text-slate-600 hover:bg-slate-50/50 transition-colors text-left"
          >
            {showThinking ? '▼ Nascondi thinking' : '▶ Mostra thinking AI'}
          </button>
          {showThinking && (
            <div className="px-3 py-2 text-[10px] text-slate-400 bg-slate-50 border-t max-h-40 overflow-y-auto whitespace-pre-wrap font-mono">
              {thinking}
            </div>
          )}
        </>
      )}
    </div>
  );
}
