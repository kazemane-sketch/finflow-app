import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/integrations/supabase/client'
import { useAuth } from './useAuth'

export interface Company {
  id: string
  name: string
  vat_number: string | null
  fiscal_code: string | null
  sdi_code: string | null
  pec: string | null
  address: string | null
  city: string | null
  province: string | null
  fiscal_regime: string | null
}

export function useCompany() {
  const { user } = useAuth()
  const [company, setCompany] = useState<Company | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchCompany = useCallback(async () => {
    if (!user) { setCompany(null); setLoading(false); return }

    // Get first company where user is member
    const { data: membership } = await supabase
      .from('company_members')
      .select('company_id')
      .eq('user_id', user.id)
      .limit(1)
      .single()

    if (membership) {
      const { data: comp } = await supabase
        .from('companies')
        .select('*')
        .eq('id', membership.company_id)
        .single()
      setCompany(comp)
    }
    setLoading(false)
  }, [user])

  useEffect(() => { fetchCompany() }, [fetchCompany])

  // Auto-create company from first invoice data (cedente/prestatore = fornitore, cessionario = noi)
  const ensureCompany = useCallback(async (cesData: {
    denom: string; piva: string; cf: string; sede: string
  }): Promise<string> => {
    if (company) return company.id

    if (!user) throw new Error('Utente non autenticato')

    // Parse address from "Via Roma 1, 00100 Roma (RM)"
    const parts = cesData.sede?.split(',').map(s => s.trim()) || []
    const address = parts[0] || ''
    const cityPart = parts[1] || ''
    const cityMatch = cityPart.match(/^(\d{5})?\s*(.+?)(?:\s*\((\w{2})\))?$/)

    const { data: newCompany, error } = await supabase
      .from('companies')
      .insert({
        name: cesData.denom || 'La mia azienda',
        vat_number: cesData.piva?.replace(/^IT/, '') || null,
        fiscal_code: cesData.cf || null,
        address: address || null,
        zip: cityMatch?.[1] || null,
        city: cityMatch?.[2] || null,
        province: cityMatch?.[3] || null,
      })
      .select()
      .single()

    if (error) throw new Error('Errore creazione azienda: ' + error.message)

    // Add user as owner
    await supabase.from('company_members').insert({
      company_id: newCompany.id,
      user_id: user.id,
      role: 'owner',
    })

    setCompany(newCompany)
    return newCompany.id
  }, [company, user])

  return { company, loading, ensureCompany, refetch: fetchCompany }
}
