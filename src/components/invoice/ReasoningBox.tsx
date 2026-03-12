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

export default function ReasoningBox({ icon, title, confidence, reasoning, thinking, variant }: Props) {
  const [showThinking, setShowThinking] = useState(false);

  const border = variant === 'blue' ? 'border-blue-200' : 'border-purple-200';
  const headerBg = variant === 'blue' ? 'bg-blue-50' : 'bg-purple-50';

  return (
    <div className={`border ${border} rounded-lg overflow-hidden`}>
      <div className={`flex items-center justify-between px-3 py-2 ${headerBg}`}>
        <span className="text-xs font-semibold">{icon} {title}</span>
        <ConfidenceBadge value={confidence} />
      </div>
      <div className="px-3 py-2 text-xs text-gray-600 leading-relaxed">
        {reasoning || <span className="italic text-gray-400">Nessun reasoning disponibile</span>}
      </div>
      {thinking && (
        <>
          <button
            onClick={() => setShowThinking(!showThinking)}
            className="px-3 py-1 text-[10px] text-gray-400 hover:text-gray-600 transition-colors"
          >
            {showThinking ? '▼ Nascondi thinking' : '▶ Mostra thinking AI'}
          </button>
          {showThinking && (
            <div className="px-3 py-2 text-[10px] text-gray-400 bg-gray-50 border-t max-h-40 overflow-y-auto whitespace-pre-wrap">
              {thinking}
            </div>
          )}
        </>
      )}
    </div>
  );
}
