import { useState, useRef, useEffect } from 'react';
import type { FiscalAlert, FiscalAlertOption } from '@/lib/classificationService';

// ─── Types ────────────────────────────────────────────────────────

export type BannerStatus = 'idle' | 'processing' | 'alerts' | 'chat' | 'done';

export interface ProgressStep {
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
}

export interface ConsultantAction {
  type: 'apply_fiscal_override';
  fiscal_override: Record<string, unknown>;
  note: string;
  reasoning: string;
  affected_line_ids: string[];
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  action?: ConsultantAction;
}

interface Props {
  status: BannerStatus;
  // idle
  onStartClassification: () => void;
  lineCount?: number;
  // processing
  progressSteps?: ProgressStep[];
  elapsedSeconds?: number;
  // alerts
  alerts?: FiscalAlert[];
  onAlertAction?: (action: { alertId: string; option: FiscalAlertOption | { type: 'consult' } }) => void;
  // chat
  chatMessages?: ChatMessage[];
  onSendMessage?: (text: string) => void;
  onApplyAction?: (action: ConsultantAction) => void;
  chatLoading?: boolean;
  chatAlertTitle?: string;
  // done
  summary?: string;
  onRestart?: () => void;
}

// ─── Component ────────────────────────────────────────────────────

export default function AIAssistantBanner({
  status,
  onStartClassification,
  lineCount,
  progressSteps,
  elapsedSeconds,
  alerts,
  onAlertAction,
  chatMessages,
  onSendMessage,
  onApplyAction,
  chatLoading,
  chatAlertTitle,
  summary,
  onRestart,
}: Props) {
  return (
    <div className="border rounded-lg bg-white overflow-hidden">
      {status === 'idle' && <IdleState onStart={onStartClassification} lineCount={lineCount} />}
      {status === 'processing' && <ProcessingState steps={progressSteps} elapsed={elapsedSeconds} />}
      {status === 'alerts' && <AlertsState alerts={alerts} onAction={onAlertAction} />}
      {status === 'chat' && (
        <ChatState
          messages={chatMessages}
          onSend={onSendMessage}
          onApply={onApplyAction}
          loading={chatLoading}
          alertTitle={chatAlertTitle}
        />
      )}
      {status === 'done' && <DoneState summary={summary} onRestart={onRestart} />}
    </div>
  );
}

// ─── Idle ─────────────────────────────────────────────────────────

function IdleState({ onStart, lineCount }: { onStart: () => void; lineCount?: number }) {
  return (
    <div className="px-4 py-5 flex items-center justify-between">
      <div>
        <p className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
          <span className="text-purple-500">&#x1F9E0;</span> Assistente AI
        </p>
        <p className="text-[11px] text-slate-400 mt-0.5">
          Classifica automaticamente {lineCount ? `${lineCount} righe` : 'le righe'} con AI
        </p>
      </div>
      <button
        onClick={onStart}
        className="px-4 py-2 text-sm font-medium rounded-lg bg-purple-600 text-white hover:bg-purple-700 transition-colors"
      >
        Suggerisci AI
      </button>
    </div>
  );
}

// ─── Processing ───────────────────────────────────────────────────

function ProcessingState({ steps, elapsed }: { steps?: ProgressStep[]; elapsed?: number }) {
  return (
    <div className="px-4 py-5 space-y-3">
      <div className="flex items-center gap-2">
        <svg className="h-5 w-5 animate-spin text-purple-500" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="text-sm font-bold text-slate-800">Classificazione in corso...</span>
        {elapsed != null && (
          <span className="text-xs text-slate-400 ml-auto">{elapsed}s</span>
        )}
      </div>
      {steps && steps.length > 0 && (
        <div className="space-y-1">
          {steps.map((s, i) => (
            <div key={i} className="flex items-center gap-2 text-[11px]">
              {s.status === 'done' && <span className="text-green-500">&#10003;</span>}
              {s.status === 'running' && <span className="text-purple-500 animate-pulse">&#9679;</span>}
              {s.status === 'pending' && <span className="text-slate-300">&#9675;</span>}
              {s.status === 'error' && <span className="text-red-500">&#10007;</span>}
              <span className={
                s.status === 'running' ? 'text-purple-600 font-bold' :
                s.status === 'done' ? 'text-slate-500' :
                s.status === 'error' ? 'text-red-600' :
                'text-slate-400'
              }>
                {s.label}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Alerts ───────────────────────────────────────────────────────

function AlertsState({
  alerts,
  onAction,
}: {
  alerts?: FiscalAlert[];
  onAction?: (action: { alertId: string; option: FiscalAlertOption | { type: 'consult' } }) => void;
}) {
  if (!alerts || alerts.length === 0) return null;

  return (
    <div className="px-4 py-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-purple-500">&#x1F9E0;</span>
        <span className="text-sm font-bold text-slate-800">Assistente AI</span>
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-200 text-amber-800">
          {alerts.length} {alerts.length === 1 ? 'alert' : 'alerts'}
        </span>
      </div>

      {alerts.map((alert, i) => (
        <div key={i} className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-[11px] font-bold text-amber-800 mb-1">&#9888; {alert.title}</p>
          <p className="text-[11px] text-amber-600 mb-2">{alert.description}</p>
          <div className="flex flex-wrap gap-1">
            {alert.options?.map((opt, j) => (
              <button
                key={j}
                onClick={() => onAction?.({ alertId: `alert-${i}`, option: opt })}
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
              onClick={() => onAction?.({ alertId: `alert-${i}`, option: { type: 'consult' } })}
              className="text-[10px] px-2 py-1 rounded border border-blue-300 bg-white text-blue-600 hover:bg-blue-50 font-medium transition-colors"
            >
              Parliamone
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Chat ─────────────────────────────────────────────────────────

function ChatState({
  messages,
  onSend,
  onApply,
  loading,
  alertTitle,
}: {
  messages?: ChatMessage[];
  onSend?: (text: string) => void;
  onApply?: (action: ConsultantAction) => void;
  loading?: boolean;
  alertTitle?: string;
}) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages?.length]);

  const handleSubmit = () => {
    if (!input.trim() || loading) return;
    onSend?.(input.trim());
    setInput('');
  };

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="px-4 py-2.5 bg-slate-50 border-b flex items-center gap-2">
        <span className="text-purple-500">&#x1F4AC;</span>
        <span className="text-sm font-bold text-slate-800">Consulente Fiscale AI</span>
        {alertTitle && (
          <span className="text-[10px] text-slate-400 ml-auto truncate max-w-[200px]">{alertTitle}</span>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="px-4 py-3 space-y-3 max-h-80 overflow-y-auto">
        {(!messages || messages.length === 0) && (
          <p className="text-[11px] text-slate-400 italic">
            Chiedi al consulente AI informazioni fiscali su questa operazione...
          </p>
        )}
        {messages?.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-lg px-3 py-2 text-[11px] leading-relaxed ${
              msg.role === 'user'
                ? 'bg-blue-600 text-white'
                : 'bg-slate-100 text-slate-700'
            }`}>
              {msg.content}
              {/* Action button if consultant suggests one */}
              {msg.role === 'assistant' && msg.action && onApply && (
                <button
                  onClick={() => onApply(msg.action!)}
                  className="mt-2 block w-full text-[10px] font-bold px-2 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                >
                  Applica: {msg.action.note || 'Applica suggerimento'}
                </button>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-slate-100 rounded-lg px-3 py-2 text-[11px] text-slate-400">
              <span className="animate-pulse">Sto pensando...</span>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="px-4 py-3 border-t flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSubmit()}
          placeholder="Scrivi una domanda fiscale..."
          className="flex-1 text-[11px] px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-purple-300 text-slate-700"
          disabled={loading}
        />
        <button
          onClick={handleSubmit}
          disabled={loading || !input.trim()}
          className="px-3 py-2 text-[11px] font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          Invia
        </button>
      </div>
    </div>
  );
}

// ─── Done ─────────────────────────────────────────────────────────

function DoneState({ summary, onRestart }: { summary?: string; onRestart?: () => void }) {
  return (
    <div className="px-4 py-4 flex items-center justify-between">
      <div>
        <p className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
          <span className="text-green-500">&#10003;</span> Classificazione completata
        </p>
        {summary && <p className="text-[11px] text-slate-500 mt-0.5">{summary}</p>}
      </div>
      {onRestart && (
        <button
          onClick={onRestart}
          className="px-3 py-1.5 text-[11px] font-medium rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
        >
          Riclassifica
        </button>
      )}
    </div>
  );
}
