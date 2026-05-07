-- Agent Identity Migration v2.4.3
-- Adds agent_id to session_map for agent-aware memory isolation

ALTER TABLE session_map ADD COLUMN IF NOT EXISTS agent_id VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_session_map_agent_id ON session_map(agent_id);
