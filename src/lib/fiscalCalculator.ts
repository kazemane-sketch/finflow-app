/**
 * fiscalCalculator.ts — Pure math for fiscal amounts + deterministic tax code mapping.
 * The AI chooses percentages/modes; this module does the arithmetic and resolves the tax code.
 */

export interface FiscalInput {
  direction: 'in' | 'out'
  vat_nature: string | null
  total_price: number
  vat_rate: number | null
  iva_xml: number | null
  iva_detraibilita_pct: number
  deducibilita_ires_pct: number
  irap_mode: 'follows_ires' | 'fully_indeducible' | 'custom_pct' | 'personale'
  irap_pct?: number
  reverse_charge: boolean
  ritenuta_applicabile: boolean
  ritenuta_aliquota_pct?: number
  ritenuta_base_pct?: number
  cassa_previdenziale_pct?: number
  competenza_dal?: string
  competenza_al?: string
  anno_esercizio: number
}

export interface ResolvedTaxCode {
  codice: string
  description: string
  match_confidence: number
}

export interface FiscalOutput {
  iva_importo: number
  iva_detraibile: number
  iva_indetraibile: number
  iva_importo_source: 'xml' | 'recomputed'
  costo_fiscale: number
  importo_deducibile_ires: number
  importo_indeducibile_ires: number
  importo_deducibile_irap: number
  importo_competenza: number
  importo_risconto: number
  ritenuta_importo: number | null
  tax_code_resolved: ResolvedTaxCode
}

/**
 * Deterministic mapping: (direction + aliquota + natura + detraibilità) → tax_code.
 * The AI does NOT choose the tax code — only iva_detraibilita_pct and reverse_charge.
 * This function translates into a tax code for accounting registration.
 */
export function risolveTaxCode(input: {
  direction: 'in' | 'out'
  vat_rate: number | null
  vat_nature: string | null
  iva_detraibilita_pct: number
  reverse_charge: boolean
}): ResolvedTaxCode {
  const { direction, vat_rate, vat_nature, iva_detraibilita_pct, reverse_charge } = input
  const rate = vat_rate ?? 0
  const natura = (vat_nature || '').toUpperCase().trim()

  // 1. Reverse charge (natura N6.x)
  if (reverse_charge || natura.startsWith('N6')) {
    return { codice: 'RC_N6', description: 'Reverse charge', match_confidence: 1.0 }
  }

  // 2. Natura codes (operazioni senza IVA)
  if (natura === 'N1') {
    return { codice: 'N1_ART15', description: 'Escluse art. 15', match_confidence: 1.0 }
  }
  if (natura.startsWith('N2')) {
    return { codice: 'N2_NON_SOGG', description: 'Non soggette', match_confidence: 1.0 }
  }
  if (natura.startsWith('N3')) {
    return { codice: 'N3_NON_IMP', description: 'Non imponibili', match_confidence: 1.0 }
  }
  if (natura === 'N4') {
    return { codice: 'N4_ESENTE', description: 'Esenti art. 10', match_confidence: 1.0 }
  }
  if (natura === 'N5' || natura === 'N7') {
    return { codice: 'N4_ESENTE', description: `Natura ${natura} (fallback esente)`, match_confidence: 0.5 }
  }

  // 3. Vendite
  if (direction === 'out') {
    if (rate >= 20) return { codice: 'VEND_22', description: 'Vendita 22%', match_confidence: 1.0 }
    if (rate >= 8) return { codice: 'VEND_10', description: 'Vendita 10%', match_confidence: 1.0 }
    if (rate >= 3) return { codice: 'VEND_4', description: 'Vendita 4%', match_confidence: 1.0 }
    return { codice: 'VEND_22', description: 'Vendita (fallback 22%)', match_confidence: 0.5 }
  }

  // 4. Acquisti con detraibilità parziale
  if (iva_detraibilita_pct <= 0) {
    return { codice: 'ACQ_IND_0', description: 'IVA totalmente indetraibile', match_confidence: 1.0 }
  }
  if (iva_detraibilita_pct <= 45) {
    return { codice: 'ACQ_AUTO_40', description: 'Auto promiscua (detr. 40%)', match_confidence: 1.0 }
  }
  if (iva_detraibilita_pct <= 55) {
    return { codice: 'ACQ_TEL_50', description: 'Telefonia (detr. 50%)', match_confidence: 1.0 }
  }

  // 5. Acquisti ordinari (detraibilità 100%)
  if (rate >= 20) return { codice: 'ACQ_22', description: 'Acquisto 22%', match_confidence: 1.0 }
  if (rate >= 8) return { codice: 'ACQ_10', description: 'Acquisto 10%', match_confidence: 1.0 }
  if (rate >= 4) return { codice: 'ACQ_5', description: 'Acquisto 5%', match_confidence: 1.0 }
  if (rate > 0) return { codice: 'ACQ_4', description: 'Acquisto 4%', match_confidence: 1.0 }

  // 6. Fallback: aliquota 0 senza natura → probabilmente esente
  return { codice: 'N4_ESENTE', description: 'Aliquota 0% senza natura (fallback)', match_confidence: 0.3 }
}

export function calcolaImportiFiscali(input: FiscalInput): FiscalOutput {
  const imp = input.total_price

  // IVA: prefer XML value if available
  let iva_importo: number
  let iva_source: 'xml' | 'recomputed'
  if (input.iva_xml != null && input.iva_xml > 0) {
    iva_importo = input.iva_xml
    iva_source = 'xml'
  } else {
    iva_importo = r2(imp * (input.vat_rate || 0) / 100)
    iva_source = 'recomputed'
  }

  const iva_detraibile = r2(iva_importo * input.iva_detraibilita_pct / 100)
  const iva_indetraibile = r2(iva_importo - iva_detraibile)

  // Costo fiscale = imponibile + IVA indetraibile
  const costo_fiscale = r2(imp + iva_indetraibile)

  // IRES
  const importo_deducibile_ires = r2(costo_fiscale * input.deducibilita_ires_pct / 100)
  const importo_indeducibile_ires = r2(costo_fiscale - importo_deducibile_ires)

  // IRAP
  let importo_deducibile_irap: number
  switch (input.irap_mode) {
    case 'fully_indeducible':
      importo_deducibile_irap = 0
      break
    case 'custom_pct':
      importo_deducibile_irap = r2(costo_fiscale * (input.irap_pct || 0) / 100)
      break
    case 'personale':
      importo_deducibile_irap = importo_deducibile_ires
      break
    default: // follows_ires
      importo_deducibile_irap = importo_deducibile_ires
  }

  // Competenza temporale
  let importo_competenza = costo_fiscale
  let importo_risconto = 0
  if (input.competenza_dal && input.competenza_al) {
    const dal = new Date(input.competenza_dal)
    const al = new Date(input.competenza_al)
    const tot = diffDays(dal, al) + 1
    if (tot > 0) {
      const qg = costo_fiscale / tot
      const ia = new Date(input.anno_esercizio, 0, 1)
      const fa = new Date(input.anno_esercizio, 11, 31)
      const s = dal > ia ? dal : ia
      const e = al < fa ? al : fa
      if (s <= e) {
        importo_competenza = r2(qg * (diffDays(s, e) + 1))
      } else {
        importo_competenza = 0
      }
      importo_risconto = r2(costo_fiscale - importo_competenza)
    }
  }

  // Ritenuta d'acconto
  let ritenuta_importo: number | null = null
  if (input.ritenuta_applicabile && input.ritenuta_aliquota_pct) {
    let base = imp
    if (input.cassa_previdenziale_pct) {
      base = r2(imp * (1 + input.cassa_previdenziale_pct / 100))
    }
    ritenuta_importo = r2(
      base * (input.ritenuta_base_pct || 100) / 100 * input.ritenuta_aliquota_pct / 100,
    )
  }

  // Deterministic tax code resolution
  const tax_code_resolved = risolveTaxCode({
    direction: input.direction,
    vat_rate: input.vat_rate,
    vat_nature: input.vat_nature,
    iva_detraibilita_pct: input.iva_detraibilita_pct,
    reverse_charge: input.reverse_charge,
  })

  return {
    iva_importo,
    iva_detraibile,
    iva_indetraibile,
    iva_importo_source: iva_source,
    costo_fiscale,
    importo_deducibile_ires,
    importo_indeducibile_ires,
    importo_deducibile_irap,
    importo_competenza,
    importo_risconto,
    ritenuta_importo,
    tax_code_resolved,
  }
}

function r2(n: number): number {
  return Math.round(n * 100) / 100
}

function diffDays(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24))
}
