-- OmO Schema Migration
-- Recreates the schema that OmOAdapter.initializeOmOSchema() would create.
-- 
-- The adapter previously used ALTER TABLE ADD COLUMN IF NOT EXISTS at runtime,
-- which works but creates schema drift risk. This migration script makes the
-- schema explicit and reproducible.
-- 
-- Run: psql -d PGOMO -f script/migration-omo-schema.sql

-- 1. Add OmO columns to existing tables
ALTER TABLE observations
  ADD COLUMN IF NOT EXISTS source_agent VARCHAR(255),
  ADD COLUMN IF NOT EXISTS agent_task_id VARCHAR(255);

ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS source_agent VARCHAR(255),
  ADD COLUMN IF NOT EXISTS agent_task_id VARCHAR(255);

ALTER TABLE semantic_cache
  ADD COLUMN IF NOT EXISTS source_agent VARCHAR(255),
  ADD COLUMN IF NOT EXISTS agent_task_id VARCHAR(255);

-- 2. Create indexes
CREATE INDEX IF NOT EXISTS idx_observations_source_agent ON observations(source_agent);
CREATE INDEX IF NOT EXISTS idx_entities_source_agent ON entities(source_agent);
CREATE INDEX IF NOT EXISTS idx_semantic_cache_source_agent ON semantic_cache(source_agent);

-- 3. Create OmO coordination table
CREATE TABLE IF NOT EXISTS omo_coordination (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id VARCHAR(255) NOT NULL,
  agent_id VARCHAR(255),
  coordination_type VARCHAR(100) NOT NULL,
  coordination_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_omo_coordination_session ON omo_coordination(session_id);
CREATE INDEX IF NOT EXISTS idx_omo_coordination_agent ON omo_coordination(agent_id);

-- 4. Note: observations.source_agent already exists (previous adapter run).
-- This migration is idempotent — safe to run multiple times.
