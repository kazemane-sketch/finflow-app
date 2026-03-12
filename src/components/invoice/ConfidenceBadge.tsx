/** Confidence badge — green >=80%, amber 60-79%, red <60% */
export default function ConfidenceBadge({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return null;
  const color =
    value >= 80 ? 'bg-green-100 text-green-700'
    : value >= 60 ? 'bg-amber-100 text-amber-700'
    : 'bg-red-100 text-red-700';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold ${color}`}>
      {value}%
    </span>
  );
}
