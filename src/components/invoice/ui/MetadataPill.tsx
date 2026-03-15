import React from 'react';

interface MetadataPillProps {
  label: string;
  value: string | React.ReactNode;
  icon?: React.ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info';
}

const variantStyles = {
  default: 'bg-slate-50 border-slate-200 text-slate-700',
  success: 'bg-emerald-50 border-emerald-200 text-emerald-700',
  warning: 'bg-amber-50 border-amber-200 text-amber-700',
  danger: 'bg-red-50 border-red-200 text-red-700',
  info: 'bg-sky-50 border-sky-200 text-sky-700',
};

export default function MetadataPill({ label, value, icon, variant = 'default' }: MetadataPillProps) {
  return (
    <div className={`flex flex-col items-start px-4 py-3 rounded-xl border ${variantStyles[variant]}`}>
      <span className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">{label}</span>
      <div className="flex items-center gap-1.5">
        {icon && <span className="text-slate-500">{icon}</span>}
        <span className="text-sm font-semibold">{value}</span>
      </div>
    </div>
  );
}

export function MetadataPillRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-3">
      {children}
    </div>
  );
}
