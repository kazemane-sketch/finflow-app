-- =============================================
-- SEED COMPANY_MEMORY + MIGRATE LEARNING_EXAMPLES
-- Populates company_memory with:
-- 1. CAVECO account mappings (from hardcoded system prompt)
-- 2. CAVECO fiscal rules (sector-specific knowledge)
-- 3. Migration from learning_examples to company_memory
-- =============================================

-- CAVECO company_id: 9f215045-578a-4c9d-af92-ca7cb9da01fe

-- ─── 8a. Account mappings — Deducibilita differenziata ───────

INSERT INTO public.company_memory (company_id, fact_type, fact_text, metadata, source)
VALUES
  -- Carburanti 100% vs 20%
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Carburanti automezzi da trasporto (camion, escavatori, pale) → conto 60812 "Carburanti 100%" (deducibilita 100%)',
   '{"account_code":"60812","deducibilita_pct":100,"category":"carburanti","vehicle_type":"trasporto"}', 'system'),

  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Carburanti auto aziendali (autovetture, SUV) → conto 608124 "Carburanti 20%" (deducibilita 20%)',
   '{"account_code":"608124","deducibilita_pct":20,"category":"carburanti","vehicle_type":"auto_aziendale"}', 'system'),

  -- Manutenzione 100% vs 20%
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Manutenzione automezzi da trasporto → conto 60720 "Manutenzione automezzi 100%" (deducibilita 100%)',
   '{"account_code":"60720","deducibilita_pct":100,"category":"manutenzione","vehicle_type":"trasporto"}', 'system'),

  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Manutenzione auto aziendali → conto 607204 "Manutenzione automezzi 20%" (deducibilita 20%)',
   '{"account_code":"607204","deducibilita_pct":20,"category":"manutenzione","vehicle_type":"auto_aziendale"}', 'system'),

  -- Assicurazioni 100% vs 20%
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Assicurazione automezzi da trasporto → conto 60822 "Assicurazioni automezzi 100%" (deducibilita 100%)',
   '{"account_code":"60822","deducibilita_pct":100,"category":"assicurazione","vehicle_type":"trasporto"}', 'system'),

  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Assicurazione auto aziendali → conto 608224 "Assicurazioni automezzi 20%" (deducibilita 20%)',
   '{"account_code":"608224","deducibilita_pct":20,"category":"assicurazione","vehicle_type":"auto_aziendale"}', 'system'),

  -- Tassa possesso 100% vs 20%
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Tassa possesso automezzi da trasporto → conto 63207 "Tassa possesso 100%" (deducibilita 100%)',
   '{"account_code":"63207","deducibilita_pct":100,"category":"tassa_possesso","vehicle_type":"trasporto"}', 'system'),

  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Tassa possesso auto aziendali → conto 632074 "Tassa possesso 20%" (deducibilita 20%)',
   '{"account_code":"632074","deducibilita_pct":20,"category":"tassa_possesso","vehicle_type":"auto_aziendale"}', 'system'),

  -- Deducibilita parziale fissa
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Spese telefoniche → conto 608530 "Spese telefoniche 80%" (deducibilita 80%, IVA 50%)',
   '{"account_code":"608530","deducibilita_pct":80,"iva_detraibile_pct":50}', 'system'),

  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Ristorazione e pernottamenti → conto 608150 "Spese ristoranti/pernott. 75%" (deducibilita 75%, IVA 100%)',
   '{"account_code":"608150","deducibilita_pct":75,"iva_detraibile_pct":100}', 'system'),

  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Spese di rappresentanza → conto 60892 (deducibilita variabile in base al fatturato)',
   '{"account_code":"60892","deducibilita_pct":"variabile"}', 'system'),

  -- Consulenze (Ritenuta d acconto)
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Consulenza amministrativa/fiscale (ATECO 69.xx) → conto 60730, ritenuta d''acconto 20% su imponibile',
   '{"account_code":"60730","ritenuta_acconto":true,"ritenuta_pct":20}', 'system'),

  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Consulenze legali (avvocati, ATECO 69.xx) → conto 6073201, ritenuta d''acconto 20%',
   '{"account_code":"6073201","ritenuta_acconto":true,"ritenuta_pct":20}', 'system'),

  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Consulenze tecniche (ingegneri, architetti, ATECO 71.xx) → conto 607320, ritenuta d''acconto 20%',
   '{"account_code":"607320","ritenuta_acconto":true,"ritenuta_pct":20}', 'system'),

  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Consulenze notarili → conto 6073202, ritenuta d''acconto 20%',
   '{"account_code":"6073202","ritenuta_acconto":true,"ritenuta_pct":20}', 'system'),

  -- Operazioni bancarie (senza fattura)
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Commissioni bancarie, spese c/c, canoni carte di credito → conto 64330 "Spese di banca"',
   '{"account_code":"64330","section":"financial","no_invoice":true}', 'system'),

  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Spese incasso RIBA/SDD → conto 64333 "Spese incasso Italia/estero"',
   '{"account_code":"64333","section":"financial","no_invoice":true}', 'system'),

  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Interessi passivi bancari → conto 64000 "Interessi passivi"',
   '{"account_code":"64000","section":"financial","no_invoice":true}', 'system'),

  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Interessi attivi bancari → conto 72031 "Altri proventi finanziari"',
   '{"account_code":"72031","section":"financial","no_invoice":true}', 'system'),

  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Imposta di bollo c/c → conto 63203 "Imposta di bollo"',
   '{"account_code":"63203","section":"other_costs","no_invoice":true}', 'system'),

  -- F24 e debiti tributari (NON sono costi)
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'F24 IRES acconto/saldo → conto debito 42056 "Erario c/acconto IRES" (NON e un costo, e un versamento di debito)',
   '{"account_code":"42056","is_debt_payment":true,"no_invoice":true}', 'system'),

  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'F24 IRAP → conto debito 42058 "Erario c/acconto IRAP" (NON e un costo, e un versamento di debito)',
   '{"account_code":"42058","is_debt_payment":true,"no_invoice":true}', 'system'),

  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'F24 ritenute dipendenti → conto debito 45000, F24 ritenute lavoro autonomo → 45003',
   '{"account_codes":["45000","45003"],"is_debt_payment":true,"no_invoice":true}', 'system'),

  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'F24 INPS → conto debito 45200, F24 INAIL → 4521001',
   '{"account_codes":["45200","4521001"],"is_debt_payment":true,"no_invoice":true}', 'system'),

  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Stipendi netti → conto debito 45420 "Personale-retribuzioni dovute" (NON e un costo, e un pagamento di debito)',
   '{"account_code":"45420","is_debt_payment":true,"no_invoice":true}', 'system'),

  -- Utenze e servizi
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Bollette energia elettrica → conto 60830, bollette gas → 60831, acquedotto → 60836',
   '{"account_codes":{"energia":"60830","gas":"60831","acquedotto":"60836"}}', 'system'),

  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Internet e provider → conto 6085301, smaltimento rifiuti → 60872',
   '{"account_codes":{"internet":"6085301","rifiuti":"60872"}}', 'system'),

  -- Leasing (pattern generico)
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Canoni leasing: ogni contratto ha un conto dedicato (609xxxx). Se non trovi il contratto, usa conto generico 6093 "Canoni Leasing". Interessi leasing vanno su 6094xxx (section: financial), MAI sullo stesso conto del canone.',
   '{"generic_canoni":"6093","interest_prefix":"6094","dedicated_prefix":"609"}', 'system'),

  -- Trasporti
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'account_mapping',
   'Trasporti su acquisti (il fornitore ci porta la merce) → conto 60412. Trasporti per vendite (noi portiamo merce al cliente) → conto 60810. Spese di trasporto generiche → conto 60702.',
   '{"trasporto_acquisti":"60412","trasporto_vendite":"60810","trasporto_generico":"60702"}', 'system')

ON CONFLICT DO NOTHING;

-- ─── 8b. Fiscal rules — Settore cave e inerti ───────────────

INSERT INTO public.company_memory (company_id, fact_type, fact_text, metadata, source)
VALUES
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'fiscal_rule',
   'Azienda di cave e inerti, ATECO 089909. Ricavi principali: vendita pozzolana (70000), calcare frantumato (70002), minerale calcare (70003), materiale da estrazione (70004), servizi (70005), trasporto (70006), noleggio (70007), manutenzione mezzi (70008), scopertura cave (70009).',
   '{"sector":"cave_inerti","ateco":"089909","revenue_codes":["70000","70002","70003","70004","70005","70006","70007","70008","70009"]}', 'system'),

  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'fiscal_rule',
   'Costi specifici cave: locazione cava (6090020), esplosivo rimborsato come ricavo (7063001). I mezzi specifici della cava (escavatori, pale, mezzi di sollevamento) hanno SEMPRE deducibilita 100%.',
   '{"cost_codes":{"locazione_cava":"6090020","esplosivo_rimborso":"7063001"},"vehicle_deducibilita":"100%"}', 'system'),

  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'fiscal_rule',
   'Per distinguere deducibilita 100% da 20%: se controparte ha ATECO trasporti (49.xx) o commercio carburanti (47.30) e azienda e cave/autotrasporto → 100%. Se fattura riguarda autovettura (targa auto) → 20%. Mezzi di cava sono SEMPRE 100%.',
   '{"rule":"deducibilita_disambiguazione","ateco_100":["49","47.30"],"vehicle_100":["escavatore","pala","camion","mezzo_sollevamento"]}', 'system'),

  -- Leasing provider patterns
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'counterparty_pattern',
   'Fornitori leasing noti: CREDEMLEASING, MPS Leasing, Daimler Truck Financial, BNP Paribas, Alba Leasing, Mercedes-Benz Financial. Cercare il numero contratto nella descrizione per abbinare al conto leasing corrispondente.',
   '{"leasing_providers":["CREDEMLEASING","MPS Leasing","Daimler Truck Financial","BNP","Alba Leasing","Mercedes-Benz Financial"]}', 'system')

ON CONFLICT DO NOTHING;

-- ─── 8c. Migrate learning_examples → company_memory ─────────

INSERT INTO public.company_memory (company_id, fact_type, fact_text, metadata, source, created_at)
SELECT
  le.company_id,
  CASE le.domain
    WHEN 'classification' THEN 'counterparty_pattern'
    WHEN 'article_assignment' THEN 'counterparty_pattern'
    WHEN 'reconciliation' THEN 'counterparty_pattern'
    ELSE 'general'
  END AS fact_type,
  CASE le.domain
    WHEN 'classification' THEN 'Classificazione confermata: ' || le.input_text || ' → ' || le.output_label
    WHEN 'article_assignment' THEN 'Articolo confermato: ' || le.input_text || ' → ' || le.output_label
    WHEN 'reconciliation' THEN 'Riconciliazione confermata: ' || le.input_text
    ELSE le.input_text || ' → ' || le.output_label
  END AS fact_text,
  COALESCE(le.metadata, '{}'::jsonb) || '{"migrated_from":"learning_examples"}'::jsonb AS metadata,
  'system' AS source,
  le.created_at
FROM public.learning_examples le
WHERE le.company_id = '9f215045-578a-4c9d-af92-ca7cb9da01fe'
  AND length(le.input_text) > 5
ON CONFLICT DO NOTHING;

-- NOTE: learning_examples table is NOT dropped for backward compatibility.
-- The old RAG search functions continue to work alongside the new company_memory system.
