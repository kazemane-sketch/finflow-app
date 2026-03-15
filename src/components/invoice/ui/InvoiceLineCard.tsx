import React from 'react';
import { CheckCircle2, AlertCircle, HelpCircle, ChevronDown, ChevronUp } from 'lucide-react';

interface LineData {
  lineNumber: number;
  description: string;
  quantity?: number;
  unitPrice?: number;
  totalPrice: number;
  vatRate?: number;
  vatNature?: string;
}

interface ClassificationData {
  categoryName?: string;
  accountName?: string;
  projectName?: string;
  confidence?: number;
  reasoning?: string;
  needsReview?: boolean;
}

interface InvoiceLineCardProps {
  line: LineData;
  classification?: ClassificationData;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  onClassificationChange?: (field: string, value: string) => void;
  fiscalBadges?: React.ReactNode;
  categoryDropdown?: React.ReactNode;
  accountDropdown?: React.ReactNode;
  projectDropdown?: React.ReactNode;
}

function ConfidenceIndicator({ value }: { value?: number }) {
  if (value == null) return null;
  
  const isHigh = value >= 80;
  const isMedium = value >= 50 && value < 80;
  
  const config = isHigh 
    ? { bg: 'bg-emerald-100', text: 'text-emerald-700', Icon: CheckCircle2 }
    : isMedium 
    ? { bg: 'bg-amber-100', text: 'text-amber-700', Icon: HelpCircle }
    : { bg: 'bg-red-100', text: 'text-red-700', Icon: AlertCircle };

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${config.bg} ${config.text}`}>
      <config.Icon className="w-3 h-3" />
      {Math.round(value)}%
    </span>
  );
}

function ValueBadge({ label, value, className = '' }: { label: string; value: string; className?: string }) {
  return (
    <div className={`flex flex-col items-center px-3 py-1.5 bg-slate-50 rounded-lg border border-slate-100 ${className}`}>
      <span className="text-[9px] uppercase tracking-wide text-slate-400">{label}</span>
      <span className="text-sm font-semibold text-slate-700 tabular-nums">{value}</span>
    </div>
  );
}

export default function InvoiceLineCard({
  line,
  classification,
  isExpanded = false,
  onToggleExpand,
  fiscalBadges,
  categoryDropdown,
  accountDropdown,
  projectDropdown,
}: InvoiceLineCardProps) {
  const formatCurrency = (n: number) => new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(n);
  const formatNumber = (n: number) => new Intl.NumberFormat('it-IT', { maximumFractionDigits: 2 }).format(n);

  return (
    <div className={`bg-white rounded-2xl border transition-all duration-200 ${
      classification?.needsReview 
        ? 'border-amber-200 shadow-amber-50' 
        : 'border-slate-200 hover:border-slate-300'
    }`}>
      {/* Header - sempre visibile */}
      <div 
        className="flex items-start justify-between p-5 cursor-pointer"
        onClick={onToggleExpand}
      >
        <div className="flex-1 min-w-0 pr-4">
          {/* Numero riga */}
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-medium text-slate-400">Riga {line.lineNumber}</span>
            <ConfidenceIndicator value={classification?.confidence} />
            {classification?.needsReview && (
              <span className="px-2 py-0.5 text-[10px] font-medium rounded-full bg-amber-100 text-amber-700">
                Da verificare
              </span>
            )}
          </div>
          
          {/* Descrizione */}
          <p className={`text-sm text-slate-800 leading-relaxed ${isExpanded ? '' : 'line-clamp-2'}`}>
            {line.description}
          </p>
          
          {/* Fiscal badges */}
          {fiscalBadges && (
            <div className="mt-2">
              {fiscalBadges}
            </div>
          )}
        </div>

        {/* Importo e expand */}
        <div className="flex items-center gap-4">
          <span className="text-lg font-bold text-slate-900 tabular-nums whitespace-nowrap">
            {formatCurrency(line.totalPrice)}
          </span>
          <button className="p-1 rounded-full hover:bg-slate-100 text-slate-400">
            {isExpanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Contenuto espanso */}
      {isExpanded && (
        <div className="px-5 pb-5 pt-0 space-y-4 border-t border-slate-100">
          {/* Valori numerici in badges orizzontali */}
          <div className="flex flex-wrap gap-2 pt-4">
            {line.quantity != null && (
              <ValueBadge label="Quantità" value={formatNumber(line.quantity)} />
            )}
            {line.unitPrice != null && (
              <ValueBadge label="Prezzo Unit." value={formatCurrency(line.unitPrice)} />
            )}
            {line.vatRate != null && (
              <ValueBadge label="IVA" value={`${line.vatRate}%`} />
            )}
            {line.vatNature && (
              <ValueBadge label="Natura" value={line.vatNature} />
            )}
          </div>

          {/* Classificazione */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {categoryDropdown && (
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-slate-400 mb-1.5">Categoria</label>
                {categoryDropdown}
              </div>
            )}
            {accountDropdown && (
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-slate-400 mb-1.5">Conto</label>
                {accountDropdown}
              </div>
            )}
            {projectDropdown && (
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-slate-400 mb-1.5">Progetto</label>
                {projectDropdown}
              </div>
            )}
          </div>

          {/* Reasoning */}
          {classification?.reasoning && (
            <div className="bg-slate-50 rounded-xl p-4 border border-slate-100">
              <span className="text-[10px] uppercase tracking-wider text-slate-400 block mb-1">Motivazione AI</span>
              <p className="text-sm text-slate-600 leading-relaxed">{classification.reasoning}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
