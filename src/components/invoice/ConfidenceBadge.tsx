/** Confidence badge: green ≥80%, yellow 60-80%, red <60% */
export default function ConfidenceBadge({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return null;
  const color =
    value >= 80 ? 'bg-green-100 text-green-700 border-green-200'
    : value >= 60 ? 'bg-yellow-100 text-yellow-700 border-yellow-200'
    : 'bg-red-100 text-red-700 border-red-200';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold border ${color}`}>
      {value}%
    </span>
  );
}
