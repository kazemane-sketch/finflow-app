import { useEffect, useMemo, useRef, useState } from 'react'
import type { FiscalAlert, FiscalAlertOption } from '@/lib/classificationService'

export type BannerStatus = 'idle' | 'processing' | 'alerts' | 'consulting' | 'proposed' | 'applied' | 'done'

export interface ProgressStep {
  label: string
  status: 'pending' | 'running' | 'done' | 'error'
}

export interface ConsultantLineUpdate {
  line_id: string
  category_id?: string | null
  account_id?: string | null
  fiscal_flags?: Record<string, unknown> | null
  decision_status?: 'pending' | 'finalized' | 'needs_review' | 'unassigned'
  reasoning_summary_final?: string | null
  final_confidence?: number | null
  note?: string | null
}

export interface ConsultantAction {
  type: 'apply_fiscal_override' | 'apply_consultant_resolution'
  fiscal_override?: Record<string, unknown>
  note?: string
  reasoning?: string
  affected_line_ids?: string[]
  recommended_conclusion?: string
  rationale_summary?: string
  risk_level?: 'low' | 'medium' | 'high'
  supporting_evidence?: Array<{ source: string; label: string; detail?: string | null; ref?: string | null }>
  expected_impact?: string
  line_updates?: ConsultantLineUpdate[]
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  thinking?: string | null
  action?: ConsultantAction
}

interface Props {
  status: BannerStatus
  onStartClassification: () => void
  lineCount?: number
  progressSteps?: ProgressStep[]
  elapsedSeconds?: number
  alerts?: FiscalAlert[]
  onAlertAction?: (action: { alertId: string; option: FiscalAlertOption | { type: 'consult' } }) => void
  chatMessages?: ChatMessage[]
  onSendMessage?: (text: string) => void
  onApplyAction?: (action: ConsultantAction) => void
  onKeepCurrentDecision?: () => void
  onAskFollowUp?: () => void
  chatLoading?: boolean
  chatAlertTitle?: string
  summary?: string
  onRestart?: () => void
  proposedAction?: ConsultantAction | null
}

export default function AIAssistantBanner(props: Props) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      {props.status === 'idle' && <IdleState onStart={props.onStartClassification} lineCount={props.lineCount} />}
      {props.status === 'processing' && <ProcessingState steps={props.progressSteps} elapsed={props.elapsedSeconds} />}
      {props.status === 'alerts' && <AlertsState alerts={props.alerts} onAction={props.onAlertAction} />}
      {props.status === 'consulting' && (
        <ConsultingState
          messages={props.chatMessages}
          onSend={props.onSendMessage}
          loading={props.chatLoading}
          alertTitle={props.chatAlertTitle}
        />
      )}
      {props.status === 'proposed' && (
        <ProposedState
          action={props.proposedAction}
          onApply={props.onApplyAction}
          onKeepCurrent={props.onKeepCurrentDecision}
          onAskFollowUp={props.onAskFollowUp}
        />
      )}
      {props.status === 'applied' && <AppliedState action={props.proposedAction} onRestart={props.onRestart} />}
      {props.status === 'done' && <DoneState summary={props.summary} onRestart={props.onRestart} />}
    </div>
  )
}

function Shell(props: { eyebrow: string; title: string; subtitle?: string; children?: React.ReactNode; accent?: 'amber' | 'blue' | 'emerald' | 'violet' }) {
  const accentStyles = {
    amber: 'text-amber-700 bg-amber-100/80 border-amber-200',
    blue: 'text-blue-700 bg-blue-100/80 border-blue-200',
    emerald: 'text-emerald-700 bg-emerald-100/80 border-emerald-200',
    violet: 'text-violet-700 bg-violet-100/80 border-violet-200',
  }[props.accent || 'violet']

  return (
    <div className="p-4 sm:p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${accentStyles}`}>
            {props.eyebrow}
          </span>
          <h3 className="mt-2 text-[15px] font-semibold text-slate-900">{props.title}</h3>
          {props.subtitle && <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-slate-500">{props.subtitle}</p>}
        </div>
      </div>
      {props.children}
    </div>
  )
}

function IdleState({ onStart, lineCount }: { onStart: () => void; lineCount?: number }) {
  return (
    <Shell
      eyebrow="Motore Fatture"
      title="Classificazione professionale con revisione finale"
      subtitle={`Il commercialista propone, il revisore consolida, il consulente interviene solo sui veri dubbi.${lineCount ? ` Fattura con ${lineCount} righe.` : ''}`}
      accent="violet"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="grid gap-2 text-[11px] text-slate-500 sm:grid-cols-3">
          <span className="rounded-xl bg-white/80 px-3 py-2">1. Exact match come evidenza, non come scorciatoia</span>
          <span className="rounded-xl bg-white/80 px-3 py-2">2. Motivazione finale unica per ogni riga</span>
          <span className="rounded-xl bg-white/80 px-3 py-2">3. Consulente laterale solo dove serve davvero</span>
        </div>
        <button
          onClick={onStart}
          className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-700"
        >
          Avvia classificazione AI
        </button>
      </div>
    </Shell>
  )
}

function ProcessingState({ steps, elapsed }: { steps?: ProgressStep[]; elapsed?: number }) {
  return (
    <Shell
      eyebrow="In lavorazione"
      title="Sto costruendo il verdetto finale della fattura"
      subtitle="La pipeline usa il commercialista per la proposta e il revisore per il consolidamento finale."
      accent="violet"
    >
      <div className="rounded-2xl border border-violet-100 bg-white/80 p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-800">
          <span className="inline-flex h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-500" />
          Elaborazione in corso
          {elapsed != null && <span className="ml-auto text-xs text-slate-400">{elapsed}s</span>}
        </div>
        <div className="space-y-2">
          {(steps || []).map((step, index) => (
            <div key={index} className="flex items-center gap-2 text-[12px]">
              <span className={
                step.status === 'done' ? 'text-emerald-600' :
                step.status === 'running' ? 'text-indigo-600' :
                step.status === 'error' ? 'text-red-600' :
                'text-slate-300'
              }>
                {step.status === 'done' ? '●' : step.status === 'running' ? '◉' : step.status === 'error' ? '✕' : '○'}
              </span>
              <span className={step.status === 'running' ? 'font-medium text-slate-800' : 'text-slate-500'}>
                {step.label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Shell>
  )
}

function AlertsState({
  alerts,
  onAction,
}: {
  alerts?: FiscalAlert[]
  onAction?: (action: { alertId: string; option: FiscalAlertOption | { type: 'consult' } }) => void
}) {
  if (!alerts?.length) return null
  return (
    <Shell
      eyebrow="Dubbi da sciogliere"
      title="Il revisore ha trovato punti che meritano una scelta esplicita"
      subtitle="Puoi applicare una scelta, oppure aprire il consulente per una second opinion contestuale."
      accent="violet"
    >
      <div className="space-y-3">
        {alerts.map((alert, index) => (
          <div key={index} className="rounded-2xl border border-violet-200 bg-white/90 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-900">{alert.title}</p>
                <p className="mt-1 text-[12px] leading-relaxed text-slate-600">{alert.description}</p>
              </div>
              <span className="rounded-full bg-violet-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-violet-700">
                {alert.severity}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {alert.options?.map((option, optionIndex) => (
                <button
                  key={optionIndex}
                  onClick={() => onAction?.({ alertId: `alert-${index}`, option })}
                  className={`rounded-xl border px-3 py-1.5 text-[11px] font-medium transition ${
                    option.isConservative
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {option.label}
                </button>
              ))}
              <button
                onClick={() => onAction?.({ alertId: `alert-${index}`, option: { type: 'consult' } })}
                className="rounded-xl border border-violet-200 bg-violet-50 px-3 py-1.5 text-[11px] font-medium text-violet-700 transition hover:bg-violet-100"
              >
                Approfondisci con consulente
              </button>
            </div>
          </div>
        ))}
      </div>
    </Shell>
  )
}

function ConsultingState({
  messages,
  onSend,
  loading,
  alertTitle,
}: {
  messages?: ChatMessage[]
  onSend?: (text: string) => void
  loading?: boolean
  alertTitle?: string
}) {
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages?.length])

  const placeholder = useMemo(
    () => alertTitle ? `Chiedi un chiarimento su: ${alertTitle}` : 'Chiedi un chiarimento fiscale o contabile su questa fattura',
    [alertTitle],
  )

  const handleSubmit = () => {
    if (!input.trim() || loading) return
    onSend?.(input.trim())
    setInput('')
  }

  return (
    <div>
      {/* Indigo header bar */}
      <div className="flex items-center gap-2.5 px-5 py-3 bg-gradient-to-r from-indigo-600 to-indigo-500">
        <span className="text-white/80 text-sm">{'\u2728'}</span>
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-white">Consulente AI Inline</span>
        <span className="text-[11px] text-white/70">{alertTitle || 'Second opinion contestuale sulla fattura'}</span>
      </div>

      {/* Chat area */}
      <div ref={scrollRef} className="max-h-80 space-y-3 overflow-y-auto px-5 py-4">
        {!messages?.length && (
          <p className="text-[12px] text-slate-400">Nessun messaggio ancora. Puoi chiedere chiarimenti o una proposta prudente applicabile.</p>
        )}
        {messages?.map((message, index) => (
          <div key={index} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 text-[12px] leading-relaxed ${
              message.role === 'user'
                ? 'bg-indigo-600 text-white'
                : 'bg-slate-100 text-slate-700'
            }`}>
              {message.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-slate-100 px-3.5 py-2.5 text-[12px] text-slate-500">
              Sto valutando il caso con thinking esteso...
            </div>
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="border-t border-slate-100 px-5 py-3">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && !event.shiftKey && handleSubmit()}
            placeholder="Scrivi un messaggio..."
            disabled={loading}
            className="flex-1 rounded-full border border-slate-200 px-4 py-2 text-[12px] text-slate-700 outline-none transition focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
          />
          <button
            onClick={handleSubmit}
            disabled={loading || !input.trim()}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-[12px] font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Invia
          </button>
        </div>
      </div>
    </div>
  )
}

function ProposedState({
  action,
  onApply,
  onKeepCurrent,
  onAskFollowUp,
}: {
  action?: ConsultantAction | null
  onApply?: (action: ConsultantAction) => void
  onKeepCurrent?: () => void
  onAskFollowUp?: () => void
}) {
  if (!action) return null
  return (
    <Shell
      eyebrow="Proposta consulente"
      title={action.recommended_conclusion || 'Risoluzione proposta pronta da applicare'}
      subtitle={action.rationale_summary || 'Il consulente ha costruito una proposta applicabile con nota esplicativa.'}
      accent="violet"
    >
      <div className="rounded-2xl border border-violet-200 bg-white/90 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Metric label="Rischio" value={action.risk_level || 'N/D'} />
          <Metric label="Impatto atteso" value={action.expected_impact || 'Non specificato'} />
        </div>
        {action.supporting_evidence?.length ? (
          <div className="mt-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Evidenze usate</p>
            <div className="mt-2 space-y-2">
              {action.supporting_evidence.map((evidence, index) => (
                <div key={index} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] text-slate-600">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-800">{evidence.label}</span>
                    <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                      {evidence.source}
                    </span>
                    {evidence.ref ? (
                      <span className="rounded-full bg-white px-2 py-0.5 font-mono text-[10px] text-slate-500">
                        {evidence.ref}
                      </span>
                    ) : null}
                  </div>
                  {evidence.detail && <span> — {evidence.detail}</span>}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {onApply && (
            <button
              onClick={() => onApply(action)}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-[12px] font-medium text-white transition hover:bg-indigo-700"
            >
              Apply recommendation
            </button>
          )}
          {onKeepCurrent && (
            <button
              onClick={onKeepCurrent}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-[12px] font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Keep current decision
            </button>
          )}
          {onAskFollowUp && (
            <button
              onClick={onAskFollowUp}
              className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-[12px] font-medium text-blue-700 transition hover:bg-blue-100"
            >
              Ask follow-up
            </button>
          )}
        </div>
      </div>
    </Shell>
  )
}

function AppliedState({ action, onRestart }: { action?: ConsultantAction | null; onRestart?: () => void }) {
  return (
    <Shell
      eyebrow="Applicato"
      title="La raccomandazione del consulente e stata applicata"
      subtitle={action?.rationale_summary || action?.note || 'La decisione finale e stata aggiornata con nota esplicativa.'}
      accent="emerald"
    >
      <div className="flex flex-col gap-3 rounded-2xl border border-emerald-200 bg-white/90 p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[12px] leading-relaxed text-slate-600">
          La motivazione finale delle righe coinvolte e stata aggiornata. Puoi rilanciare la classificazione o continuare la revisione manuale.
        </p>
        {onRestart && (
          <button
            onClick={onRestart}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-[12px] font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Riclassifica
          </button>
        )}
      </div>
    </Shell>
  )
}

function DoneState({ summary, onRestart }: { summary?: string; onRestart?: () => void }) {
  return (
    <Shell
      eyebrow="Completato"
      title="La fattura ha un verdetto finale consolidato"
      subtitle={summary || 'Le righe sono state analizzate e la UI mostra solo la motivazione finale applicata.'}
      accent="emerald"
    >
      <div className="flex flex-col gap-3 rounded-2xl border border-emerald-200 bg-white/90 p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[12px] text-slate-600">Puoi comunque riaprire il consulente o rilanciare la pipeline se hai nuovo contesto.</p>
        {onRestart && (
          <button
            onClick={onRestart}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-[12px] font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Riclassifica
          </button>
        )}
      </div>
    </Shell>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-1 text-[12px] font-medium text-slate-800">{value}</p>
    </div>
  )
}
