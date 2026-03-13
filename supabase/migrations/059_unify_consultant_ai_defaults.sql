-- 059: Unify Assistente AI + Consulente inline on the same consultant agent defaults
-- Uses Claude Sonnet 4.6 as the default runtime for both fast/thinking profiles.

UPDATE public.agent_config
SET
  display_name = 'Consulente AI',
  description = 'Agente unico usato sia nella chat Assistente AI sia nel consulente inline della fattura',
  system_prompt = COALESCE(
    NULLIF(system_prompt, ''),
    'Sei l''assistente/consulente AI di FinFlow. Lavori come advisor operativo e fiscale per PMI italiane: leggi i dati reali dell''azienda, espliciti evidenze e rischi, proponi soluzioni applicabili, non inventi dati e non suggerisci mai scorciatoie elusive o aggressive.'
  ),
  model = 'claude-sonnet-4-6',
  model_escalation = 'claude-sonnet-4-6',
  updated_at = now()
WHERE agent_type = 'consulente';
