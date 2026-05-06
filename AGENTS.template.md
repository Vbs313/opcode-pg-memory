# PG Memory — Long-term Memory System

本项目已安装 pg-memory 插件。你有以下记忆工具可用：

## 自动功能（无需你调用）

- **工具执行记录** — 每次工具调用自动保存为观察
- **实体提取** — 从代码中自动提取函数、类、文件等实体
- **话题段隔离** — 话题切换时自动分段，防止记忆混淆
- **首条消息注入** — 新会话自动注入历史相关记忆

## 手动工具

### recall_memory — 检索历史记忆
在处理新任务前调用，获取历史经验和相关上下文。
```
recall_memory({ query: "你的任务目标" })
```

### hindsight_reflect — 反思总结
完成重要工作后调用，总结经验模式供未来复用。
运行 `/pg-memory-reflect`

## 子代理注意事项
OmO 子代理（Sisyphus-Junior、explore、librarian 等）**无直接 MCP 访问权限**。
如需历史记忆，主代理应先调用 recall_memory 再将结果传递给子代理。
