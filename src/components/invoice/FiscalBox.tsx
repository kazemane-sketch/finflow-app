import { useState } from 'react';
import ConfidenceBadge from './ConfidenceBadge';
import FiscalFlagsBadges from './FiscalFlagsBadges';

interface FiscalFlags {
  deducibilita_pct?: number;
  iva_detraibilita_pct?: number;
  reverse_charge?: boolean;
  split_payment?: boolean;
  bene_strumentale?: boolean;
  ritenuta_acconto?: number;
  note?: string;
}

interface AlertOption {
  label: string;
  type: string;
  isConservative?: boolean;
  fiscalUpdate?: Record<string, unknown>;
  suggestedNote?: string;
}

interface Alert {
  id: string;
  title: string;
  description: string;
  options?: AlertOption[];
}

interface Props {
  icon: string;
  title: string;
  confidence: number | null | undefined;
  reasoning: string | null | undefined;
  thinking: string | null | undefined;
  fiscalFlags: FiscalFlags | null | undefined;
  alerts?: Alert[];
  onAlertAction?: (action: { alertId: string; option: AlertOption | { type: 'consult' } }) => void;
}

/** Fiscal analysis card — Test Lab style */
export default function FiscalBox({
  icon, title, confidence, reasoning, thinking, fiscalFlags, alerts, onAlertAction,
}: Props) {
  const [showThinking, setShowThinking] = useState(false);

  return (
    <div className="border rounded-lg bg-white overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-b">
        <span className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
          <span className="text-purple-500">{icon}</span> {title}
        </span>
        <ConfidenceBadge value={confidence} />
      </div>

      {/* Fiscal flags badges */}
      {fiscalFlags && (
        <div className="px-3 py-1.5 border-b">
          <FiscalFlagsBadges flags={fiscalFlags} />
        </div>
      )}

      {/* Reasoning */}
      <div className="px-3 py-2 text-[11px] text-slate-600 leading-relaxed">
        {reasoning || <span className="italic text-slate-400">Nessun reasoning disponibile</span>}
      </div>

      {/* Alerts with smart buttons */}
      {alerts?.map((alert, i) => (
        <div key={i} className="mx-3 mb-2 p-2 bg-amber-50 border border-amber-200 rounded">
          <p className="text-[10px] font-bold text-amber-800 mb-1">&#9888; {alert.title}</p>
          <p className="text-[10px] text-amber-600 mb-2">{alert.description}</p>
          <div className="flex flex-wrap gap-1">
            {alert.options?.map((opt, j) => (
              <button
                key={j}
                onClick={() => onAlertAction?.({ alertId: alert.id, option: opt })}
                className={`text-[10px] px-2 py-1 rounded border font-medium transition-colors ${
                  opt.isConservative
                    ? 'border-green-300 bg-green-50 text-green-700 hover:bg-green-100'
                    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                {opt.label}
              </button>
            ))}
            <button
              onClick={() => onAlertAction?.({ alertId: alert.id, option: { type: 'consult' } })}
              className="text-[10px] px-2 py-1 rounded border border-blue-300 bg-white text-blue-600 hover:bg-blue-50 font-medium transition-colors"
            >
              Parliamone
            </button>
          </div>
        </div>
      ))}

      {/* Thinking toggle */}
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
