import React from 'react';
import { Building2, Calendar, Hash, Clock, MoreHorizontal, FileEdit, Trash2, Download, ArrowUpRight, ArrowDownLeft } from 'lucide-react';
import MetadataPill, { MetadataPillRow } from './MetadataPill';

interface CounterpartyInfo {
  name: string;
  vatNumber?: string;
  fiscalCode?: string;
  sector?: string;
  province?: string;
}

interface InvoiceHeaderCardProps {
  // Invoice data
  direction: 'in' | 'out';
  number: string;
  date: string;
  dueDate?: string;
  totalAmount: number;
  paymentStatus: 'pending' | 'overdue' | 'paid';
  
  // Counterparty
  counterparty: CounterpartyInfo;
  
  // Actions
  onEdit?: () => void;
  onDelete?: () => void;
  onDownload?: () => void;
  
  // Optional extras
  isNota?: boolean;
  hasFiscalAlerts?: boolean;
  isReconciled?: boolean;
}

const statusConfig = {
  pending: { label: 'Da pagare', variant: 'warning' as const },
  overdue: { label: 'Scaduta', variant: 'danger' as const },
  paid: { label: 'Pagata', variant: 'success' as const },
};

function getInitials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map(w => w[0])
    .join('')
    .toUpperCase();
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(amount);
}

export default function InvoiceHeaderCard({
  direction,
  number,
  date,
  dueDate,
  totalAmount,
  paymentStatus,
  counterparty,
  onEdit,
  onDelete,
  onDownload,
  isNota,
  hasFiscalAlerts,
  isReconciled,
}: InvoiceHeaderCardProps) {
  const status = statusConfig[paymentStatus];
  const [showActions, setShowActions] = React.useState(false);

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Header principale */}
      <div className="p-6">
        <div className="flex items-start justify-between gap-6">
          {/* Sinistra: Avatar + Info controparte */}
          <div className="flex items-start gap-4 flex-1 min-w-0">
            {/* Avatar */}
            <div className={`flex-shrink-0 w-14 h-14 rounded-2xl flex items-center justify-center text-lg font-bold ${
              direction === 'in' 
                ? 'bg-sky-100 text-sky-700' 
                : 'bg-emerald-100 text-emerald-700'
            }`}>
              {getInitials(counterparty.name)}
            </div>
            
            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                {direction === 'in' ? (
                  <ArrowDownLeft className="w-4 h-4 text-sky-500" />
                ) : (
                  <ArrowUpRight className="w-4 h-4 text-emerald-500" />
                )}
                <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                  {direction === 'in' ? 'Ricevuta' : 'Emessa'}
                </span>
                {isNota && (
                  <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-red-100 text-red-700">
                    NOTA CREDITO
                  </span>
                )}
              </div>
              
              <h2 className="text-xl font-semibold text-slate-900 truncate mb-1">
                {counterparty.name}
              </h2>
              
              <div className="flex items-center gap-3 text-sm text-slate-500">
                {counterparty.vatNumber && (
                  <span>P.IVA {counterparty.vatNumber}</span>
                )}
                {counterparty.sector && (
                  <>
                    <span className="text-slate-300">•</span>
                    <span>{counterparty.sector}</span>
                  </>
                )}
                {counterparty.province && (
                  <>
                    <span className="text-slate-300">•</span>
                    <span>{counterparty.province}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Destra: Importo */}
          <div className="flex flex-col items-end">
            <span className="text-3xl font-bold text-slate-900 tabular-nums">
              {formatCurrency(totalAmount)}
            </span>
            <span className={`mt-1 px-3 py-1 text-xs font-semibold rounded-full ${
              status.variant === 'success' ? 'bg-emerald-100 text-emerald-700' :
              status.variant === 'warning' ? 'bg-amber-100 text-amber-700' :
              'bg-red-100 text-red-700'
            }`}>
              {status.label}
            </span>
          </div>
        </div>
      </div>

      {/* Metadata pills + actions */}
      <div className="px-6 pb-6 flex items-end justify-between gap-4">
        <MetadataPillRow>
          <MetadataPill 
            label="Numero" 
            value={number}
            icon={<Hash className="w-3.5 h-3.5" />}
          />
          <MetadataPill 
            label="Data" 
            value={formatDate(date)}
            icon={<Calendar className="w-3.5 h-3.5" />}
          />
          {dueDate && (
            <MetadataPill 
              label="Scadenza" 
              value={formatDate(dueDate)}
              icon={<Clock className="w-3.5 h-3.5" />}
              variant={paymentStatus === 'overdue' ? 'danger' : 'default'}
            />
          )}
          {hasFiscalAlerts && (
            <MetadataPill 
              label="Attenzione" 
              value="Alert fiscali"
              variant="warning"
            />
          )}
          {isReconciled && (
            <MetadataPill 
              label="Stato" 
              value="Riconciliata"
              variant="success"
            />
          )}
        </MetadataPillRow>

        {/* Actions */}
        <div className="relative">
          <button 
            onClick={() => setShowActions(!showActions)}
            className="p-2 rounded-xl hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
          >
            <MoreHorizontal className="w-5 h-5" />
          </button>
          
          {showActions && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowActions(false)} />
              <div className="absolute right-0 top-full mt-1 z-20 bg-white rounded-xl shadow-lg border border-slate-200 py-1 min-w-[160px]">
                {onEdit && (
                  <button 
                    onClick={() => { onEdit(); setShowActions(false); }}
                    className="w-full px-4 py-2 text-sm text-left text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                  >
                    <FileEdit className="w-4 h-4" />
                    Modifica
                  </button>
                )}
                {onDownload && (
                  <button 
                    onClick={() => { onDownload(); setShowActions(false); }}
                    className="w-full px-4 py-2 text-sm text-left text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                  >
                    <Download className="w-4 h-4" />
                    Scarica XML
                  </button>
                )}
                {onDelete && (
                  <button 
                    onClick={() => { onDelete(); setShowActions(false); }}
                    className="w-full px-4 py-2 text-sm text-left text-red-600 hover:bg-red-50 flex items-center gap-2"
                  >
                    <Trash2 className="w-4 h-4" />
                    Elimina
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
