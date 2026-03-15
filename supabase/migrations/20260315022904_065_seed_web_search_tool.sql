INSERT INTO public.agent_tools (agent_type, tool_name, display_name, description, sort_order) 
VALUES 
  ('commercialista', 'web_search', 'Ricerca Web', 'Cerca info aggiornate sul web (Tavily per Gemini, nativo per Claude/OpenAI)', 8), 
  ('consulente', 'web_search', 'Ricerca Web', 'Cerca info aggiornate sul web (Tavily per Gemini, nativo per Claude/OpenAI)', 12) 
ON CONFLICT (agent_type, tool_name) DO NOTHING;
