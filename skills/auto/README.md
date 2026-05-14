# 自动生成技能

此目录由 opcode-pg-memory 自主反思引擎自动填充。每个子目录包含一个 agentskills.io 兼容的 SKILL.md 文件。

## 生成条件
- reflection confidence ≥ 0.85
- action_plan.action.type ∈ {"template", "suggestion"}
- 非 "rule" 类型（规则写入 rules.md）

## 目录结构
```
skills/auto/
├── auto-error_pattern-abc12345/
│   └── SKILL.md
├── auto-workflow-def67890/
│   └── SKILL.md
└── ...
```

## 生命周期
- **生成**: session.completed 钩子自动触发
- **加载**: Agent 启动时渐进式披露（只读取 YAML frontmatter）
- **淘汰**: 手动删除或 git revert
- **版本控制**: 建议提交到 git 以跟踪技能演化

> 由 opcode-pg-memory v3.16+ 管理
