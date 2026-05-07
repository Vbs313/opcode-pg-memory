-- ============================================================
-- Migration: opcode-pg-memory v1.0 → v2.0
-- Date: 2026-05-06
-- ============================================================
-- 
-- Changes:
-- 1. Create session_map table (replaces sessions table)
-- 2. Create topic_segments table (NEW)
-- 3. Add topic_segment_id FK to entities, observations, relations, reflections
-- 4. Add omo_task_id to session_map
-- 5. Migrate data from old sessions to session_map
-- 6. Update indexes for new FK columns
-- ============================================================

BEGIN;

-- ============================================================
-- Step 1: Create session_map table
-- ============================================================
CREATE TABLE IF NOT EXISTS session_map (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    opencode_session_id VARCHAR(255) UNIQUE NOT NULL,
    omo_task_id VARCHAR(255),
    project_id VARCHAR(255),
    model_context_limit INTEGER NOT NULL DEFAULT 128000,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_active_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

-- ============================================================
-- Step 2: Migrate data from sessions to session_map
-- ============================================================
INSERT INTO session_map (opencode_session_id, project_id, model_context_limit, created_at, last_active_at, metadata)
SELECT 
    external_id,
    project_id,
    model_context_limit,
    created_at,
    updated_at,
    metadata
FROM sessions
ON CONFLICT (opencode_session_id) DO NOTHING;

-- ============================================================
-- Step 3: Create topic_segments table
-- ============================================================
CREATE TABLE IF NOT EXISTS topic_segments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_map_id UUID NOT NULL REFERENCES session_map(id) ON DELETE CASCADE,
    segment_index INTEGER NOT NULL,
    summary TEXT,
    embedding vector(1536),
    start_message_external_id VARCHAR(255),
    end_message_external_id VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    observation_count INTEGER DEFAULT 0,
    metadata JSONB DEFAULT '{}',
    UNIQUE(session_map_id, segment_index)
);

-- ============================================================
-- Step 4: Add topic_segment_id to entities
-- ============================================================
ALTER TABLE entities
ADD COLUMN IF NOT EXISTS topic_segment_id UUID REFERENCES topic_segments(id) ON DELETE SET NULL;

-- ============================================================
-- Step 5: Add topic_segment_id to observations
-- ============================================================
ALTER TABLE observations
ADD COLUMN IF NOT EXISTS topic_segment_id UUID REFERENCES topic_segments(id) ON DELETE SET NULL;

-- ============================================================
-- Step 6: Add topic_segment_id to relations
-- ============================================================
ALTER TABLE relations
ADD COLUMN IF NOT EXISTS topic_segment_id UUID REFERENCES topic_segments(id) ON DELETE SET NULL;

-- ============================================================
-- Step 7: Add topic_segment_id to reflections
-- ============================================================
ALTER TABLE reflections
ADD COLUMN IF NOT EXISTS topic_segment_id UUID REFERENCES topic_segments(id) ON DELETE SET NULL;

-- ============================================================
-- Step 8: Add topic_segment_id to semantic_cache
-- ============================================================
ALTER TABLE semantic_cache
ADD COLUMN IF NOT EXISTS topic_segment_id UUID REFERENCES topic_segments(id) ON DELETE SET NULL;

-- ============================================================
-- Step 9: Update semantic_cache to reference session_map
-- (add new column, migrate data, drop old)
-- ============================================================
ALTER TABLE semantic_cache
ADD COLUMN IF NOT EXISTS session_map_id UUID REFERENCES session_map(id) ON DELETE SET NULL;

-- ============================================================
-- Step 10: Update token_usage_log to reference session_map
-- ============================================================
ALTER TABLE token_usage_log
ADD COLUMN IF NOT EXISTS session_map_id UUID REFERENCES session_map(id) ON DELETE CASCADE;

-- ============================================================
-- Step 11: Update reflection_errors to reference session_map
-- ============================================================
ALTER TABLE reflection_errors
ADD COLUMN IF NOT EXISTS session_map_id UUID REFERENCES session_map(id) ON DELETE CASCADE;

-- ============================================================
-- Step 12: Create indexes
-- ============================================================

-- session_map indexes
CREATE INDEX IF NOT EXISTS idx_session_map_opencode_id ON session_map(opencode_session_id);
CREATE INDEX IF NOT EXISTS idx_session_map_omo_task_id ON session_map(omo_task_id);
CREATE INDEX IF NOT EXISTS idx_session_map_project_id ON session_map(project_id);

-- topic_segments indexes
CREATE INDEX IF NOT EXISTS idx_topic_segments_session ON topic_segments(session_map_id);
CREATE INDEX IF NOT EXISTS idx_topic_segments_embedding ON topic_segments 
USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_topic_segments_closed ON topic_segments(closed_at) WHERE closed_at IS NULL;

-- entities indexes (updated)
CREATE INDEX IF NOT EXISTS idx_entities_topic ON entities(topic_segment_id);

-- observations indexes (updated)
CREATE INDEX IF NOT EXISTS idx_observations_topic ON observations(topic_segment_id);

-- relations indexes (updated)
CREATE INDEX IF NOT EXISTS idx_relations_topic ON relations(topic_segment_id);

-- reflections indexes (updated)
CREATE INDEX IF NOT EXISTS idx_reflections_topic ON reflections(topic_segment_id);

-- semantic_cache indexes (updated)
CREATE INDEX IF NOT EXISTS idx_semantic_cache_topic ON semantic_cache(topic_segment_id);
CREATE INDEX IF NOT EXISTS idx_semantic_cache_session_map ON semantic_cache(session_map_id);

-- ============================================================
-- Step 13: Add OmO support columns (if OmO is enabled)
-- ============================================================
DO $$
BEGIN
    -- Add source_agent to relevant tables
    ALTER TABLE entities ADD COLUMN IF NOT EXISTS source_agent VARCHAR(255);
    ALTER TABLE observations ADD COLUMN IF NOT EXISTS source_agent VARCHAR(255);
    ALTER TABLE reflections ADD COLUMN IF NOT EXISTS source_agent VARCHAR(255);
    ALTER TABLE topic_segments ADD COLUMN IF NOT EXISTS source_agent VARCHAR(255);
EXCEPTION WHEN OTHERS THEN
    -- Column already exists or table doesn't have it yet
    NULL;
END $$;

-- ============================================================
-- Verification queries (run after migration)
-- ============================================================
-- Check row counts:
-- SELECT 'session_map' as table_name, COUNT(*) FROM session_map
-- UNION ALL SELECT 'topic_segments', COUNT(*) FROM topic_segments
-- UNION ALL SELECT 'entities (with topic)', COUNT(*) FROM entities WHERE topic_segment_id IS NOT NULL;
--
-- Check that session_map has the same rows as old sessions:
-- SELECT 
--   (SELECT COUNT(*) FROM sessions) as old_count,
--   (SELECT COUNT(*) FROM session_map) as new_count;

COMMIT;

-- ============================================================
-- Rollback script (save separately as migration_rollback.sql)
-- ============================================================
-- BEGIN;
-- DROP TABLE IF EXISTS topic_segments CASCADE;
-- DROP TABLE IF EXISTS session_map CASCADE;
-- ALTER TABLE entities DROP COLUMN IF EXISTS topic_segment_id;
-- ALTER TABLE observations DROP COLUMN IF EXISTS topic_segment_id;
-- ALTER TABLE relations DROP COLUMN IF EXISTS topic_segment_id;
-- ALTER TABLE reflections DROP COLUMN IF EXISTS topic_segment_id;
-- ALTER TABLE semantic_cache DROP COLUMN IF EXISTS topic_segment_id;
-- ALTER TABLE semantic_cache DROP COLUMN IF EXISTS session_map_id;
-- ALTER TABLE token_usage_log DROP COLUMN IF EXISTS session_map_id;
-- ALTER TABLE reflection_errors DROP COLUMN IF EXISTS session_map_id;
-- COMMIT;
