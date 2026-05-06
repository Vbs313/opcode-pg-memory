-- ============================================================
-- opcode-pg-memory v2.3.2 — 数据库重构
-- 基于 OpenCode 真实 SQLite 数据结构重新设计
-- ============================================================
-- 
-- 核心原则（来自 重构.md G1-G6）：
-- 1. 不存储原始消息（OpenCode SQLite 是唯一消息源）
-- 2. 只存储提炼后的高阶知识
-- 3. 每条记录必须可追溯到 OpenCode 原始数据
-- 4. 支持 EventSynchronizer 乐观锁
-- ============================================================

BEGIN;

-- ============================================================
-- 1. session_map — 会话映射（优化 + 乐观锁）
-- ============================================================
ALTER TABLE session_map ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;
ALTER TABLE session_map ADD COLUMN IF NOT EXISTS omo_task_id VARCHAR(255);

-- ============================================================
-- 2. topic_segments — 话题段（小优化）
-- ============================================================
-- 已有 start_message_external_id 和 end_message_external_id，OK

-- ============================================================
-- 3. observations — 观察记录（重构）
-- 
-- 对应 OpenCode part.data JSON 结构：
--   { type: 'tool', tool: 'bash', callID: 'call_xxx',
--     state: { status, input, output } }
-- ============================================================
ALTER TABLE observations ADD COLUMN IF NOT EXISTS tool_call_id VARCHAR(255);
ALTER TABLE observations ADD COLUMN IF NOT EXISTS message_external_id VARCHAR(255);
ALTER TABLE observations ADD COLUMN IF NOT EXISTS part_external_id VARCHAR(255);
ALTER TABLE observations ADD COLUMN IF NOT EXISTS tool_status VARCHAR(50);
  -- pending / running / completed / failed
ALTER TABLE observations ADD COLUMN IF NOT EXISTS tool_parameters JSONB;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS tool_error TEXT;

-- 索引
CREATE INDEX IF NOT EXISTS idx_observations_tool_call ON observations(tool_call_id);
CREATE INDEX IF NOT EXISTS idx_observations_message ON observations(message_external_id);
CREATE INDEX IF NOT EXISTS idx_observations_part ON observations(part_external_id);
CREATE INDEX IF NOT EXISTS idx_observations_status ON observations(tool_status);

-- ============================================================
-- 4. entities — 实体（增加溯源字段）
-- ============================================================
ALTER TABLE entities ADD COLUMN IF NOT EXISTS message_external_id VARCHAR(255);
ALTER TABLE entities ADD COLUMN IF NOT EXISTS part_external_id VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_entities_message ON entities(message_external_id);
CREATE INDEX IF NOT EXISTS idx_entities_part ON entities(part_external_id);

-- ============================================================
-- 5. messages — 删除（还原为 OpenCode SQLite 唯一持有）
-- ============================================================
-- messages 表中可能还有历史数据，先备份再删除
-- 备份已有的 message_id 到 observations（确保引用不丢失）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'messages') THEN
    -- 将 messages 表的 message_id 同步到 observations
    UPDATE observations o
    SET message_external_id = m.message_id
    FROM messages m
    WHERE o.session_map_id = m.session_id
      AND o.message_external_id IS NULL;
  END IF;
END $$;

-- 删除 messages 表（引用已清除）
DROP TABLE IF EXISTS messages CASCADE;

-- ============================================================
-- 6. semantic_cache — 清理旧 FK
-- ============================================================
-- 检查是否有旧的 session_id 列（关联 sessions 表）
-- 如果存在且不再需要，可以删除
-- （目前已有 session_map_id，忽略 session_id）

-- ============================================================
-- 7. sessions — 旧表只保留注释（legacy）
-- ============================================================
COMMENT ON TABLE sessions IS '_legacy: replaced by session_map. DO NOT USE for new code.';

-- ============================================================
-- 验证
-- ============================================================
-- SELECT table_name, column_name FROM information_schema.columns
-- WHERE table_name IN ('observations','entities','session_map')
-- ORDER BY table_name, ordinal_position;

COMMIT;
