import React from 'react';
import { FileText, FileCheck, CreditCard, StickyNote } from 'lucide-react';

export type DetailTab = 'dettaglio' | 'documento' | 'pagamenti' | 'note';

interface TabConfig {
  key: DetailTab;
  label: string;
  icon: React.ElementType;
  badge?: number;
}

const TABS: TabConfig[] = [
  { key: 'dettaglio', label: 'Dettaglio', icon: FileText },
  { key: 'documento', label: 'Documento', icon: FileCheck },
  { key: 'pagamenti', label: 'Pagamenti', icon: CreditCard },
  { key: 'note', label: 'Note', icon: StickyNote },
];

interface InvoiceTabNavProps {
  activeTab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  badges?: Partial<Record<DetailTab, number>>;
  attentionDot?: Partial<Record<DetailTab, boolean>>;
}

export default function InvoiceTabNav({ activeTab, onTabChange, badges, attentionDot }: InvoiceTabNavProps) {
  return (
    <div className="flex items-center gap-2 p-1.5 bg-slate-100 rounded-2xl">
      {TABS.map((tab) => {
        const isActive = activeTab === tab.key;
        const Icon = tab.icon;
        const badgeCount = badges?.[tab.key];
        const hasAttention = attentionDot?.[tab.key];
        
        return (
          <button
            key={tab.key}
            onClick={() => onTabChange(tab.key)}
            className={`
              relative flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all duration-200
              ${isActive 
                ? 'bg-white text-slate-900 shadow-sm' 
                : 'text-slate-500 hover:text-slate-700 hover:bg-white/50'
              }
            `}
          >
            <Icon className="w-4 h-4" />
            <span>{tab.label}</span>
            
            {badgeCount != null && badgeCount > 0 && (
              <span className="ml-1 px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-slate-200 text-slate-600">
                {badgeCount}
              </span>
            )}
            
            {hasAttention && (
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            )}
          </button>
        );
      })}
    </div>
  );
}
