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

  const ensureCompany = useCallback(async (cesData: {
    denom: string; piva: string; cf: string; sede: string
  }): Promise<string> => {
    if (company) return company.id
    if (!user) throw new Error('Utente non autenticato')

    // Parse address
    const parts = cesData.sede?.split(',').map(s => s.trim()) || []
    const address = parts[0] || null
    const cityPart = parts[1] || ''
    const cityMatch = cityPart.match(/^(\d{5})?\s*(.+?)(?:\s*\((\w{2})\))?$/)

    // Use RPC function (bypasses RLS)
    const { data: companyId, error } = await supabase.rpc('create_company_with_owner', {
      p_name: cesData.denom || 'La mia azienda',
      p_vat_number: cesData.piva?.replace(/^IT/, '') || null,
      p_fiscal_code: cesData.cf || null,
      p_address: address,
      p_zip: cityMatch?.[1] || null,
      p_city: cityMatch?.[2] || null,
      p_province: cityMatch?.[3] || null,
    })

    if (error) throw new Error('Errore creazione azienda: ' + error.message)

    // Fetch the created company
    const { data: newCompany } = await supabase
      .from('companies')
      .select('*')
      .eq('id', companyId)
      .single()

    setCompany(newCompany)
    return companyId
  }, [company, user])

  return { company, loading, ensureCompany, refetch: fetchCompany }
}
