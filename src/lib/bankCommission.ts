function parseLocalizedAmount(raw: string): number | null {
  const normalized = String(raw || '')
    .replace(/\s+/g, '')
    .replace(/\.(?=\d{3}(?:\D|$))/g, '')
    .replace(',', '.')
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

export function extractCommissionAmountFromRawText(rawText: string | null | undefined): number | null {
  const source = String(rawText || '')
  if (!source) return null

  for (const pattern of [
    /\bCOMM\.?\s*[:=]?\s*([0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]{2})|[0-9]+(?:,[0-9]{2}))/i,
    /\bCOMMISSIONI?\s*[:=]?\s*([0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]{2})|[0-9]+(?:,[0-9]{2}))/i,
  ]) {
    const match = source.match(pattern)
    if (!match?.[1]) continue
    const parsed = parseLocalizedAmount(match[1])
    if (parsed != null && parsed > 0) return parsed
  }

  return null
}

export function resolveSignedCommissionAmount(
  explicitCommission: number | string | null | undefined,
  rawText: string | null | undefined,
): number | null {
  const explicit = explicitCommission != null ? Number(explicitCommission) : null
  if (explicit != null && Number.isFinite(explicit) && explicit !== 0) {
    return -Math.abs(explicit)
  }

  const extracted = extractCommissionAmountFromRawText(rawText)
  return extracted != null ? -Math.abs(extracted) : null
}
