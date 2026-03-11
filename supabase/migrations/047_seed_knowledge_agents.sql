-- 047_seed_knowledge_agents.sql
-- Seed: Agent config + Knowledge Base rules + Agent rules
-- See migration applied via MCP in multiple parts (047_seed_agent_config, 047_seed_kb_iva, etc.)
-- This file documents the full seed for version control.

-- Agent configs: commercialista + revisore (with full system prompts)
-- Knowledge Base: ~30 rules across domains (iva, ires_irap, ritenute, classificazione, settoriale, operativo)
-- Agent Rules: 8 per commercialista + 8 per revisore

-- NOTE: Actual data was seeded via apply_migration MCP tool.
-- To re-seed on a fresh DB, run the individual INSERT statements from the migration history.
