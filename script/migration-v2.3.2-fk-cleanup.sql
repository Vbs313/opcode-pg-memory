-- ============================================================
-- 清理所有指向 sessions(id) 的旧 FK 约束
-- 
-- 背景：v1→v2 迁移时，列名 session_id 改成了 session_map_id，
-- 但 FK 目标仍然是 sessions(id) 而非 session_map(id)。
-- 这导致 INSERT 到 observations 时只能用旧 sessions 的 UUID。
--
-- 本迁移：将 FK 目标从 sessions(id) 改为 session_map(id)
-- ============================================================

BEGIN;

-- ============================================================
-- 第一步：建立 sessions.id → session_map.id 映射
-- sessions 和 session_map 通过 opencode_session_id 关联
-- ============================================================

-- 为不存在对应 session_map 条目的 sessions 创建映射
INSERT INTO session_map (opencode_session_id)
SELECT external_id FROM sessions s
WHERE NOT EXISTS (SELECT 1 FROM session_map sm WHERE sm.opencode_session_id = s.external_id)
ON CONFLICT (opencode_session_id) DO NOTHING;

-- ============================================================
-- 第二步：更新所有子表 FK 值
-- ============================================================

-- entities
UPDATE entities e
SET session_map_id = sm.id
FROM session_map sm, sessions s
WHERE sm.opencode_session_id = s.external_id
  AND e.session_map_id = s.id;

-- observations
UPDATE observations o
SET session_map_id = sm.id
FROM session_map sm, sessions s
WHERE sm.opencode_session_id = s.external_id
  AND o.session_map_id = s.id;

-- relations
UPDATE relations r
SET session_map_id = sm.id
FROM session_map sm, sessions s
WHERE sm.opencode_session_id = s.external_id
  AND r.session_map_id = s.id;

-- reflections
UPDATE reflections r
SET session_map_id = sm.id
FROM session_map sm, sessions s
WHERE sm.opencode_session_id = s.external_id
  AND r.session_map_id = s.id;

-- semantic_cache (旧的 session_id FK 指向 sessions)
UPDATE semantic_cache sc
SET session_id = sm.id::text
FROM session_map sm, sessions s
WHERE sm.opencode_session_id = s.external_id
  AND sc.session_id = s.id::text;

-- semantic_cache (session_map_id)
UPDATE semantic_cache sc
SET session_map_id = sm.id
FROM session_map sm, sessions s
WHERE sm.opencode_session_id = s.external_id
  AND sc.session_map_id = s.id;

-- token_usage_log
UPDATE token_usage_log tl
SET session_map_id = sm.id
FROM session_map sm, sessions s
WHERE sm.opencode_session_id = s.external_id
  AND tl.session_map_id = s.id;

-- reflection_errors
UPDATE reflection_errors re
SET session_map_id = sm.id
FROM session_map sm, sessions s
WHERE sm.opencode_session_id = s.external_id
  AND re.session_map_id = s.id;

-- ============================================================
-- 第三步：删除旧 FK 约束
-- ============================================================

ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_session_id_fkey;
ALTER TABLE observations DROP CONSTRAINT IF EXISTS observations_session_id_fkey;
ALTER TABLE relations DROP CONSTRAINT IF EXISTS relations_session_id_fkey;
ALTER TABLE reflections DROP CONSTRAINT IF EXISTS reflections_session_id_fkey;
ALTER TABLE reflection_errors DROP CONSTRAINT IF EXISTS reflection_errors_session_id_fkey;
ALTER TABLE semantic_cache DROP CONSTRAINT IF EXISTS semantic_cache_session_id_fkey;
ALTER TABLE token_usage_log DROP CONSTRAINT IF EXISTS token_usage_log_session_id_fkey;

-- ============================================================
-- 第四步：创建新 FK 约束 → session_map(id)
-- ============================================================

ALTER TABLE entities ADD CONSTRAINT entities_session_map_id_fkey
  FOREIGN KEY (session_map_id) REFERENCES session_map(id) ON DELETE CASCADE;

ALTER TABLE observations ADD CONSTRAINT observations_session_map_id_fkey
  FOREIGN KEY (session_map_id) REFERENCES session_map(id) ON DELETE CASCADE;

ALTER TABLE relations ADD CONSTRAINT relations_session_map_id_fkey
  FOREIGN KEY (session_map_id) REFERENCES session_map(id) ON DELETE CASCADE;

ALTER TABLE reflections ADD CONSTRAINT reflections_session_map_id_fkey
  FOREIGN KEY (session_map_id) REFERENCES session_map(id) ON DELETE CASCADE;

ALTER TABLE reflection_errors ADD CONSTRAINT reflection_errors_session_map_id_fkey
  FOREIGN KEY (session_map_id) REFERENCES session_map(id) ON DELETE CASCADE;

ALTER TABLE token_usage_log ADD CONSTRAINT token_usage_log_session_map_id_fkey
  FOREIGN KEY (session_map_id) REFERENCES session_map(id) ON DELETE CASCADE;

-- semantic_cache 已有 session_map_id FK，删除旧的 session_id 列
ALTER TABLE semantic_cache DROP COLUMN IF EXISTS session_id;

-- ============================================================
-- 验证
-- ============================================================
-- SELECT conname, conrelid::regclass, pg_get_constraintdef(oid)
-- FROM pg_constraint WHERE contype = 'f' AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
-- AND pg_get_constraintdef(oid) LIKE '%sessions%';

COMMIT;
