import { useState } from 'react';
import ConfidenceBadge from './ConfidenceBadge';

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

export default function FiscalBox({
  icon, title, confidence, reasoning, thinking, fiscalFlags, alerts, onAlertAction,
}: Props) {
  const [showThinking, setShowThinking] = useState(false);

  return (
    <div className="border border-purple-200 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-purple-50">
        <span className="text-xs font-semibold">{icon} {title}</span>
        <ConfidenceBadge value={confidence} />
      </div>

      {/* Fiscal flags badges */}
      {fiscalFlags && (
        <div className="px-3 py-1.5 flex flex-wrap gap-1">
          {fiscalFlags.deducibilita_pct !== undefined && (
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-gray-200 bg-gray-50 font-medium">
              Deduc. {fiscalFlags.deducibilita_pct}%
            </span>
          )}
          {fiscalFlags.iva_detraibilita_pct !== undefined && (
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-gray-200 bg-gray-50 font-medium">
              IVA detr. {fiscalFlags.iva_detraibilita_pct}%
            </span>
          )}
          {fiscalFlags.reverse_charge && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">Reverse Charge</span>
          )}
          {fiscalFlags.split_payment && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">Split Payment</span>
          )}
          {fiscalFlags.bene_strumentale && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-medium">Bene strumentale</span>
          )}
          {fiscalFlags.ritenuta_acconto && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 font-medium">
              Ritenuta {fiscalFlags.ritenuta_acconto}%
            </span>
          )}
        </div>
      )}

      {/* Reasoning */}
      <div className="px-3 py-2 text-xs text-gray-600 leading-relaxed">
        {reasoning || <span className="italic text-gray-400">Nessun reasoning disponibile</span>}
      </div>

      {/* Alerts with smart buttons */}
      {alerts?.map((alert, i) => (
        <div key={i} className="mx-3 mb-2 p-2 bg-amber-50 border border-amber-200 rounded">
          <p className="text-[10px] font-semibold text-amber-800 mb-1">⚠ {alert.title}</p>
          <p className="text-[10px] text-amber-600 mb-2">{alert.description}</p>
          <div className="flex flex-wrap gap-1">
            {alert.options?.map((opt, j) => (
              <button
                key={j}
                onClick={() => onAlertAction?.({ alertId: alert.id, option: opt })}
                className={`text-[10px] px-2 py-1 rounded border font-medium transition-colors ${
                  opt.isConservative
                    ? 'border-green-300 bg-green-50 text-green-700 hover:bg-green-100'
                    : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                }`}
              >
                {opt.label}
              </button>
            ))}
            <button
              onClick={() => onAlertAction?.({ alertId: alert.id, option: { type: 'consult' } })}
              className="text-[10px] px-2 py-1 rounded border border-blue-300 bg-white text-blue-600 hover:bg-blue-50 font-medium transition-colors"
            >
              💬 Parliamone
            </button>
          </div>
        </div>
      ))}

      {/* Thinking toggle */}
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
