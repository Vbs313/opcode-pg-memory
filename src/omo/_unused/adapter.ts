/**
 * Oh My OpenAgent (OmO) 适配器
 *
 * 将 PG Memory 插件升格为 OmO 基础设施的核心适配层
 * 处理多 Agent 环境下的记忆隔离、注入和反思
 */

import { Pool } from 'pg';
import {
  OmOConfig,
  DEFAULT_OMO_CONFIG,
  OmOAgent,
  OmOTaskContext,
  OmOMemoryQuery,
  OmOMemoryInjection,
  OmOReflectionResult,
  OmOTaskCreatedEvent,
  OmOTaskCompletedEvent,
  OmOAgentSpawnedEvent,
  OmODCPCoordination,
  OmOHookType
} from './types';
import { recallMemory, RecallMemoryInput } from '../mcp/recall-memory';
import { hindsightReflect, HindsightReflectInput } from '../mcp/hindsight-reflect';
import { calculateTokenBudget } from '../utils/token-budget';

export interface OmOAdapterOptions {
  config?: Partial<OmOConfig>;
  pool: Pool;
  // OmO 回调接口
  omOCallbacks?: {
    onWisdomCreated?: (wisdom: any) => Promise<void>;
    onContextInjected?: (injection: OmOMemoryInjection) => Promise<void>;
    getOmOContextBudget?: (agentId: string) => Promise<number>;
  };
}

/**
 * OmO 适配器主类
 */
export class OmOAdapter {
  private config: OmOConfig;
  private pool: Pool;
  private callbacks: OmOAdapterOptions['omOCallbacks'];

  // Agent 运行时状态
  private agentContexts = new Map<string, {
    agent: OmOAgent;
    taskStack: string[];
    injectedTokenCount: number;
  }>();

  // DCP 协调状态
  private dcpCoordination: OmODCPCoordination = {
    omODCPEnabled: false,
    pgMemoryDCPEnabled: true,
    coordinationMode: 'pg-memory-only',
    activeDCPProvider: 'pg-memory'
  };

  constructor(options: OmOAdapterOptions) {
    this.config = { ...DEFAULT_OMO_CONFIG, ...options.config };
    this.pool = options.pool;
    this.callbacks = options.omOCallbacks;
  }

  // ==================== 初始化与配置 ====================

  /**
   * 初始化 OmO 适配器
   */
  async initialize(): Promise<void> {
    console.log('[OmO Adapter] Initializing...');
    console.log(`[OmO Adapter] Integration mode: ${this.config.integrationMode}`);
    console.log(`[OmO Adapter] Agent isolation: ${this.config.agentIsolation.enabled ? 'enabled' : 'disabled'}`);

    // 检查 OmO 环境
    await this.detectOmOEnvironment();

    // 初始化数据库（添加 OmO 相关字段）
    await this.initializeOmOSchema();

    console.log('[OmO Adapter] Initialized successfully');
  }

  /**
   * 检测 OmO 环境
   */
  private async detectOmOEnvironment(): Promise<void> {
    // 检查环境变量
    const omOEnvVars = [
      'OMO_ENABLED',
      'OMO_SESSION_ID',
      'OMO_AGENT_ID',
      'OH_MY_OPENAGENT_CONFIG'
    ];

    const detected = omOEnvVars.filter(v => process.env[v]);

    if (detected.length > 0) {
      console.log(`[OmO Adapter] Detected OmO environment: ${detected.join(', ')}`);
      this.config.enabled = true;
    } else {
      console.log('[OmO Adapter] OmO environment not detected, running in standalone mode');
      this.config.enabled = false;
    }
  }

  /**
   * 初始化 OmO 相关的数据库 Schema
   */
  private async initializeOmOSchema(): Promise<void> {
    // 添加 source_agent 字段到相关表
    const tables = ['observations', 'semantic_cache', 'entities'];

    for (const table of tables) {
      try {
        await this.pool.query(`
          ALTER TABLE ${table}
          ADD COLUMN IF NOT EXISTS source_agent VARCHAR(255),
          ADD COLUMN IF NOT EXISTS agent_task_id VARCHAR(255)
        `);

        // 创建索引
        await this.pool.query(`
          CREATE INDEX IF NOT EXISTS idx_${table}_source_agent ON ${table}(source_agent)
        `);
      } catch (error) {
        console.warn(`[OmO Adapter] Schema update warning for ${table}:`, error);
      }
    }

    // 创建 OmO 协调状态表
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS omo_coordination (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id VARCHAR(255) NOT NULL,
        agent_id VARCHAR(255),
        coordination_type VARCHAR(100) NOT NULL,
        coordination_data JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    console.log('[OmO Adapter] Schema initialized');
  }

  // ==================== OmO 生命周期钩子处理 ====================

  /**
   * 处理 omo.task.created
   * 在任务创建时注入相关记忆
   */
  async onTaskCreated(event: OmOTaskCreatedEvent): Promise<OmOMemoryInjection> {
    console.log(`[OmO Adapter] Task created: ${event.taskId} for agent: ${event.agentId}`);

    // 注册 Agent 上下文
    if (!this.agentContexts.has(event.agentId)) {
      this.agentContexts.set(event.agentId, {
        agent: {
          id: event.agentId,
          name: event.agentId,
          role: 'worker'
        },
        taskStack: [],
        injectedTokenCount: 0
      });
    }

    const agentContext = this.agentContexts.get(event.agentId)!;
    agentContext.taskStack.push(event.taskId);

    // 根据配置决定是否注入记忆
    if (this.config.skillMode?.autoInject &&
        this.config.skillMode.injectTiming === 'pre-task') {
      return this.injectMemoryForTask(event);
    }

    return {
      agentId: event.agentId,
      taskId: event.taskId,
      injectedMemories: [],
      tokenCount: 0,
      sourceTiers: {},
      omOBudgetReserved: 0,
      coordinationApplied: false
    };
  }

  /**
   * 处理 omo.task.completed
   * 触发反思任务
   */
  async onTaskCompleted(event: OmOTaskCompletedEvent): Promise<OmOReflectionResult | null> {
    console.log(`[OmO Adapter] Task completed: ${event.taskId}`);

    const agentContext = this.agentContexts.get(event.agentId);
    if (agentContext) {
      // 从任务栈中移除
      const index = agentContext.taskStack.indexOf(event.taskId);
      if (index > -1) {
        agentContext.taskStack.splice(index, 1);
      }
    }

    // 检查是否需要触发反思
    if (this.config.wisdomIntegration.enabled &&
        event.observationsCount >= (this.config.infrastructureMode?.observationThreshold || 30)) {
      return this.performReflection(event);
    }

    return null;
  }

  /**
   * 处理 omo.agent.spawned
   * 初始化子 Agent 的上下文
   */
  async onAgentSpawned(event: OmOAgentSpawnedEvent): Promise<void> {
    console.log(`[OmO Adapter] Agent spawned: ${event.agentId}`);

    this.agentContexts.set(event.agentId, {
      agent: {
        id: event.agentId,
        name: event.agentId,
        role: event.role as any,
        parentAgentId: event.parentAgentId
      },
      taskStack: [],
      injectedTokenCount: 0
    });

    // 如果有父 Agent，继承部分上下文
    if (event.parentAgentId && this.config.agentIsolation.enabled) {
      await this.inheritParentContext(event.agentId, event.parentAgentId);
    }
  }

  /**
   * 处理 omo.context.injection
   * OmO 的上下文注入钩子（如果启用）
   */
  async onContextInjection(agentId: string, taskContext: any): Promise<OmOMemoryInjection> {
    // 如果我们在 infrastructure 模式，接管上下文注入
    if (this.config.integrationMode === 'infrastructure') {
      return this.injectMemoryForAgent(agentId, taskContext);
    }

    // 否则返回空，让 OmO 处理
    return {
      agentId,
      injectedMemories: [],
      tokenCount: 0,
      sourceTiers: {},
      omOBudgetReserved: 0,
      coordinationApplied: false
    };
  }

  // ==================== 记忆注入核心逻辑 ====================

  /**
   * 为任务注入记忆
   */
  private async injectMemoryForTask(event: OmOTaskCreatedEvent): Promise<OmOMemoryInjection> {
    const query: OmOMemoryQuery = {
      query: `Task: ${event.taskType}`,
      sessionId: event.sessionId,
      agentId: event.agentId,
      taskId: event.taskId,
      agentScope: 'all',
      tierFilter: this.config.agentIsolation.sharedTiers,
      includeOmOWisdom: this.config.wisdomIntegration.useOmOWisdom
    };

    return this.executeMemoryInjection(query);
  }

  /**
   * 为 Agent 注入记忆
   */
  private async injectMemoryForAgent(agentId: string, context: any): Promise<OmOMemoryInjection> {
    const agentContext = this.agentContexts.get(agentId);
    if (!agentContext) {
      return {
        agentId,
        injectedMemories: [],
        tokenCount: 0,
        sourceTiers: {},
        omOBudgetReserved: 0,
        coordinationApplied: false
      };
    }

    const query: OmOMemoryQuery = {
      query: context.taskDescription || 'General context',
      sessionId: context.sessionId,
      agentId,
      agentScope: 'siblings',
      tierFilter: ['permanent', 'project', 'session']
    };

    return this.executeMemoryInjection(query);
  }

  /**
   * 执行记忆注入
   */
  private async executeMemoryInjection(query: OmOMemoryQuery): Promise<OmOMemoryInjection> {
    // 1. 计算 Token 预算（与 OmO 协调）
    const budget = await this.calculateCoordinatedBudget(query.agentId);

    // 2. 检索记忆
    const recallInput: RecallMemoryInput = {
      query: query.query,
      session_id: query.sessionId,
      retrieval_strategies: query.strategies || ['semantic', 'bm25'],
      max_results: 10,
      filters: {
        tier_levels: query.tierFilter as any,
        min_confidence: 0.5
      }
    };

    const recallResult = await recallMemory(recallInput, this.pool);

    // 3. 按 Agent 范围过滤
    const filteredResults = await this.filterByAgentScope(
      recallResult.results,
      query.agentId,
      query.agentScope
    );

    // 4. 应用 Token 预算限制
    const selectedMemories: string[] = [];
    let usedTokens = 0;
    const sourceTiers: Record<string, number> = {};

    for (const result of filteredResults) {
      const tokens = Math.ceil(result.content.length / 4); // 简化估算

      if (usedTokens + tokens <= budget.pgMemoryBudget) {
        selectedMemories.push(result.content);
        usedTokens += tokens;

        const tier = result.metadata.tier || 'unknown';
        sourceTiers[tier] = (sourceTiers[tier] || 0) + 1;
      } else {
        break;
      }
    }

    const injection: OmOMemoryInjection = {
      agentId: query.agentId,
      taskId: query.taskId,
      injectedMemories: selectedMemories,
      tokenCount: usedTokens,
      sourceTiers,
      omOBudgetReserved: budget.omOReserved,
      coordinationApplied: this.config.tokenBudgetCoordination.enabled
    };

    // 5. 通知 OmO
    if (this.callbacks?.onContextInjected) {
      await this.callbacks.onContextInjected(injection);
    }

    // 6. 更新 Agent 上下文
    const agentContext = this.agentContexts.get(query.agentId);
    if (agentContext) {
      agentContext.injectedTokenCount = usedTokens;
    }

    return injection;
  }

  /**
   * 按 Agent 范围过滤结果
   */
  private async filterByAgentScope(
    results: any[],
    agentId: string,
    scope: OmOMemoryQuery['agentScope']
  ): Promise<any[]> {
    if (scope === 'all' || !this.config.agentIsolation.enabled) {
      return results;
    }

    const agentContext = this.agentContexts.get(agentId);
    if (!agentContext) {
      return results;
    }

    switch (scope) {
      case 'self':
        // 只返回当前 Agent 的记忆
        return results.filter(r =>
          r.metadata.source_agent === agentId ||
          r.metadata.tier === 'permanent' ||
          r.metadata.tier === 'project'
        );

      case 'siblings':
        // 返回同级 Agent 的记忆（共享 project 层级）
        return results.filter(r =>
          r.metadata.tier === 'permanent' ||
          r.metadata.tier === 'project' ||
          r.metadata.source_agent === agentId
        );

      case 'parent':
        // 返回父 Agent 的记忆
        if (agentContext.agent.parentAgentId) {
          return results.filter(r =>
            r.metadata.source_agent === agentContext.agent.parentAgentId ||
            r.metadata.tier === 'permanent' ||
            r.metadata.tier === 'project'
          );
        }
        return results;

      case 'children':
        // 返回子 Agent 的记忆
        const childAgents = Array.from(this.agentContexts.values())
          .filter(ctx => ctx.agent.parentAgentId === agentId)
          .map(ctx => ctx.agent.id);

        return results.filter(r =>
          childAgents.includes(r.metadata.source_agent) ||
          r.metadata.tier === 'permanent' ||
          r.metadata.tier === 'project'
        );

      default:
        return results;
    }
  }

  /**
   * 计算与 OmO 协调的 Token 预算
   */
  private async calculateCoordinatedBudget(agentId: string): Promise<{
    pgMemoryBudget: number;
    omOReserved: number;
    totalBudget: number;
  }> {
    const defaultBudget = 2000; // 默认预算

    if (!this.config.tokenBudgetCoordination.enabled) {
      return {
        pgMemoryBudget: defaultBudget,
        omOReserved: 0,
        totalBudget: defaultBudget
      };
    }

    // 获取 OmO 的预算信息
    let omOBudget = defaultBudget;
    if (this.callbacks?.getOmOContextBudget) {
      omOBudget = await this.callbacks.getOmOContextBudget(agentId);
    }

    const coordination = this.config.tokenBudgetCoordination;
    const maxOmORatio = coordination.maxOmOContextRatio;

    let pgMemoryBudget: number;
    let omOReserved: number;

    switch (coordination.budgetAllocation) {
      case 'omo-first':
        omOReserved = Math.min(omOBudget * maxOmORatio, omOBudget * 0.7);
        pgMemoryBudget = omOBudget - omOReserved;
        break;

      case 'equal':
        pgMemoryBudget = Math.floor(omOBudget * 0.5);
        omOReserved = omOBudget - pgMemoryBudget;
        break;

      case 'memory-first':
        pgMemoryBudget = Math.min(defaultBudget, omOBudget * 0.6);
        omOReserved = omOBudget - pgMemoryBudget;
        break;

      default:
        pgMemoryBudget = defaultBudget;
        omOReserved = 0;
    }

    return {
      pgMemoryBudget,
      omOReserved,
      totalBudget: omOBudget
    };
  }

  // ==================== 反思与 Wisdom 集成 ====================

  /**
   * 执行反思任务
   */
  private async performReflection(
    event: OmOTaskCompletedEvent
  ): Promise<OmOReflectionResult> {
    console.log(`[OmO Adapter] Triggering reflection for agent: ${event.agentId}`);

    const reflectInput: HindsightReflectInput = {
      session_id: event.sessionId,
      trigger_type: 'threshold',
      model_size: '7b'
    };

    const result = await hindsightReflect(reflectInput, this.pool);

    const firstReflection = result.generated_reflections[0];
    const reflectionResult: OmOReflectionResult = {
      reflectionId: firstReflection?.id || '',
      agentId: event.agentId,
      sessionId: event.sessionId,
      patterns: result.generated_reflections.map((r: any) => ({
        patternType: r.pattern_type || 'insight',
        description: r.summary,
        confidence: r.confidence,
        sourceObservationIds: r.source_observation_ids
      }))
    };

    // 同步到 OmO Wisdom
    if (this.config.wisdomIntegration.syncToOmO && this.callbacks?.onWisdomCreated) {
      const wisdomEntry = {
        id: reflectionResult.reflectionId,
        type: 'pattern' as const,
        content: firstReflection?.summary || '',
        metadata: {
          source: 'pg-memory-hindsight' as const,
          agentId: event.agentId,
          timestamp: new Date().toISOString(),
          confidence: firstReflection?.confidence || 0
        }
      };

      reflectionResult.wisdomEntry = wisdomEntry;
      await this.callbacks.onWisdomCreated(wisdomEntry);
    }

    return reflectionResult;
  }

  /**
   * 继承父 Agent 的上下文
   */
  private async inheritParentContext(childAgentId: string, parentAgentId: string): Promise<void> {
    console.log(`[OmO Adapter] Agent ${childAgentId} inheriting context from ${parentAgentId}`);

    // 记录继承关系到数据库
    await this.pool.query(`
      INSERT INTO omo_coordination (session_id, agent_id, coordination_type, coordination_data)
      VALUES ($1, $2, $3, $4)
    `, [
      'inheritance',
      childAgentId,
      'parent-child',
      JSON.stringify({
        parentAgentId,
        inheritedAt: new Date().toISOString()
      })
    ]);
  }

  // ==================== DCP 协调 ====================

  /**
   * 设置 DCP 协调模式
   */
  setDCPCoordination(coordination: Partial<OmODCPCoordination>): void {
    this.dcpCoordination = { ...this.dcpCoordination, ...coordination };

    console.log(`[OmO Adapter] DCP coordination updated:`, {
      mode: this.dcpCoordination.coordinationMode,
      activeProvider: this.dcpCoordination.activeDCPProvider
    });
  }

  /**
   * 获取 DCP 协调状态
   */
  getDCPCoordination(): OmODCPCoordination {
    return this.dcpCoordination;
  }

  // ==================== 工具方法 ====================

  /**
   * 获取 Agent 统计信息
   */
  async getAgentStats(agentId: string): Promise<{
    observationCount: number;
    cacheHitRate: number;
    reflectionCount: number;
    activeTasks: number;
  }> {
    const [obsResult, cacheResult, reflResult] = await Promise.all([
      this.pool.query(
        'SELECT COUNT(*) FROM observations WHERE source_agent = $1',
        [agentId]
      ),
      this.pool.query(`
        SELECT AVG(hit_count) as avg_hits
        FROM semantic_cache
        WHERE source_agent = $1
      `, [agentId]),
      this.pool.query(
        'SELECT COUNT(*) FROM reflections WHERE metadata->>agentId = $1',
        [agentId]
      )
    ]);

    const agentContext = this.agentContexts.get(agentId);

    return {
      observationCount: parseInt(obsResult.rows[0].count, 10),
      cacheHitRate: parseFloat(cacheResult.rows[0]?.avg_hits || 0),
      reflectionCount: parseInt(reflResult.rows[0].count, 10),
      activeTasks: agentContext?.taskStack.length || 0
    };
  }

  /**
   * 获取配置
   */
  getConfig(): OmOConfig {
    return this.config;
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<OmOConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * 将 MemoryResult 格式化为 Agent 可解析的结构化文本
 * 
 * 用于 OmO Agent 的系统提示词注入，使 Agent 能够消费记忆结果
 * 并融入决策链条。
 * 
 * @param results - recall_memory 返回的结果列表
 * @param maxPerType - 每种类型最多输出的条数 (默认: 5)
 * @returns 格式化后的 Markdown 字符串
 */
export function formatMemoriesForAgent(
  results: Array<{
    id: string;
    type: string;
    data: Record<string, any>;
    relevance_score: number;
    context: string;
  }>,
  maxPerType: number = 5
): string {
  if (!results || results.length === 0) {
    return '';
  }

  const lines: string[] = ['## 相关历史记忆'];
  const counts: Record<string, number> = {};

  for (const r of results) {
    const type = r.type || 'unknown';
    counts[type] = (counts[type] || 0) + 1;

    // 限制每种类型的输出数量
    if (counts[type] > maxPerType) continue;

    const relevance = r.relevance_score ? ` (相关度: ${(r.relevance_score * 100).toFixed(0)}%)` : '';
    const contextInfo = r.context ? ` [来源: ${r.context}]` : '';

    switch (type) {
      case 'reflection':
        lines.push(`- 💡 **经验反思**${relevance}: ${r.data.summary || r.data.description || ''}${contextInfo}`);
        break;

      case 'observation':
        lines.push(`- 📋 **操作记录**${relevance}: 工具 \`${r.data.tool_name || 'unknown'}\` → ${(r.data.tool_output_summary || '').substring(0, 200)}${contextInfo}`);
        break;

      case 'entity':
        lines.push(`- 🏷️ **实体** [${r.data.type || 'unknown'}]${relevance}: ${r.data.name || 'unknown'} — ${(r.data.description || '').substring(0, 150)}${contextInfo}`);
        break;

      case 'relation':
        lines.push(`- 🔗 **关系**${relevance}: ${r.data.description || ''} (${r.data.relation_type || 'unknown'})${contextInfo}`);
        break;

      default:
        lines.push(`- 📝 **${type}**${relevance}: ${JSON.stringify(r.data).substring(0, 200)}${contextInfo}`);
    }
  }

  // 添加统计摘要
  const stats = Object.entries(counts)
    .map(([type, count]) => `${type}: ${count}`)
    .join(', ');
  
  if (stats) {
    lines.push(`\n> 共检索到 ${results.length} 条记忆 (${stats})`);
  }

  return lines.join('\n');
}

/**
 * 为 Agent 系统提示词生成记忆使用指南
 * 
 * 将此函数的输出注入到 OmO Agent 的系统提示词中，
 * 以便 Agent 知道如何自主调用 recall_memory 和 hindsight_reflect。
 * 
 * @returns Agent 系统提示词片段
 */
export function getMemoryAgentInstructions(): string {
  return `## 长期记忆工具

你可以使用以下记忆工具来增强任务执行：

### recall_memory — 检索历史记忆
在处理新任务前，建议调用此工具获取相关历史经验。
参数建议：
- query: 你当前的任务目标或核心问题
- caller_context: { type: "omo_agent", current_goal: "<任务目标>" }
- retrieval_strategies: ["semantic", "bm25", "graph"]

### hindsight_reflect — 总结任务经验
在完成任务后，调用此工具反思本次执行过程。
参数建议：
- trigger_type: "manual"
- model_size: "7b"
- aggregate: false (每个话题单独反思)`;
}

/**
 * 创建 OmO 适配器实例
 */
export function createOmOAdapter(options: OmOAdapterOptions): OmOAdapter {
  return new OmOAdapter(options);
}