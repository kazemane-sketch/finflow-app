interface FiscalFlags {
  deducibilita_pct?: number;
  iva_detraibilita_pct?: number;
  reverse_charge?: boolean;
  split_payment?: boolean;
  bene_strumentale?: boolean;
  ritenuta_acconto?: number;
  note?: string;
}

/** Inline fiscal flag badges — Test Lab style */
export default function FiscalFlagsBadges({ flags }: { flags: FiscalFlags | null | undefined }) {
  if (!flags) return null;

  const badges: { label: string; cls: string }[] = [];

  if (flags.deducibilita_pct !== undefined) {
    badges.push({
      label: `Deduc. ${flags.deducibilita_pct}%`,
      cls: 'bg-slate-100 text-slate-600',
    });
  }
  if (flags.iva_detraibilita_pct !== undefined) {
    badges.push({
      label: `IVA detr. ${flags.iva_detraibilita_pct}%`,
      cls: 'bg-slate-100 text-slate-600',
    });
  }
  if (flags.reverse_charge) {
    badges.push({
      label: 'Reverse Charge',
      cls: 'bg-orange-100 text-orange-700',
    });
  }
  if (flags.split_payment) {
    badges.push({
      label: 'Split Payment',
      cls: 'bg-orange-100 text-orange-700',
    });
  }
  if (flags.bene_strumentale) {
    badges.push({
      label: 'Bene strumentale',
      cls: 'bg-sky-100 text-sky-700',
    });
  }
  if (flags.ritenuta_acconto) {
    badges.push({
      label: `Ritenuta ${flags.ritenuta_acconto}%`,
      cls: 'bg-red-100 text-red-700',
    });
  }

  if (badges.length === 0) return null;

  return (
    <span className="inline-flex flex-wrap gap-1">
      {badges.map((b, i) => (
        <span
          key={i}
          className={`text-[9px] px-1 rounded font-medium ${b.cls}`}
        >
          {b.label}
        </span>
      ))}
    </span>
  );
}
