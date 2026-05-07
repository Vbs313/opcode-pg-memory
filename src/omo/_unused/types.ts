/**
 * Oh My OpenAgent (OmO) 适配层类型定义
 * 
 * 定义 OmO 特有的类型和接口，用于多 Agent 环境下的记忆管理
 */

// OmO Agent 类型
export interface OmOAgent {
  id: string;
  name: string;
  role: 'orchestrator' | 'worker' | 'specialist' | 'infrastructure';
  parentAgentId?: string;
  taskId?: string;
  metadata?: Record<string, any>;
}

// OmO 任务上下文
export interface OmOTaskContext {
  taskId: string;
  sessionId: string;
  agentId: string;
  parentTaskId?: string;
  taskType: string;
  priority: number;
  deadline?: Date;
}

// OmO 生命周期钩子（48个钩子的子集，与记忆相关）
export type OmOHookType =
  | 'omo.task.created'
  | 'omo.task.assigned'
  | 'omo.task.started'
  | 'omo.task.completed'
  | 'omo.task.failed'
  | 'omo.agent.spawned'
  | 'omo.agent.terminated'
  | 'omo.context.injection'
  | 'omo.wisdom.accumulation'
  | 'omo.session.init'
  | 'omo.session.cleanup';

// OmO 配置
export interface OmOConfig {
  enabled: boolean;
  // 与 OmO 的集成模式: 'skill' | 'infrastructure' | 'hybrid'
  integrationMode: 'skill' | 'infrastructure' | 'hybrid';
  
  // 基础设施模式配置
  infrastructureMode?: {
    priority: 'high' | 'normal' | 'low';
    reservedForAgents: string[]; // 哪些 Agent 可以使用
    disabledOmOHooks: OmOHookType[]; // 禁用的 OmO 钩子（避免冲突）
    observationThreshold?: number; // 触发反思的观察阈值
  };
  
  // Skill 模式配置
  skillMode?: {
    skillName: string;
    autoInject: boolean;
    injectTiming: 'pre-task' | 'on-demand';
  };
  
  // 多 Agent 隔离配置
  agentIsolation: {
    enabled: boolean;
    sharedTiers: ('permanent' | 'project')[]; // 哪些层级跨 Agent 共享
    isolatedTiers: ('session' | 'agent')[];   // 哪些层级 Agent 隔离
  };
  
  // 与 OmO Wisdom Accumulation 的集成
  wisdomIntegration: {
    enabled: boolean;
    syncToOmO: boolean;      // 将 hindsight_reflect 结果同步到 OmO
    useOmOWisdom: boolean;   // 使用 OmO 的 Wisdom 作为补充
    conflictResolution: 'omo-priority' | 'pg-memory-priority' | 'merge';
  };
  
  // Token 预算与 OmO 协调
  tokenBudgetCoordination: {
    enabled: boolean;
    respectOmOBudget: boolean;  // 尊重 OmO 的预算控制
    budgetAllocation: 'omo-first' | 'equal' | 'memory-first';
    maxOmOContextRatio: number; // OmO 上下文最大占比
  };
}

// OmO 默认配置
export const DEFAULT_OMO_CONFIG: OmOConfig = {
  enabled: true,
  integrationMode: 'infrastructure',
  
  infrastructureMode: {
    priority: 'high',
    reservedForAgents: ['*'], // 所有 Agent
    disabledOmOHooks: [
      'omo.context.injection',  // 禁用 OmO 的上下文注入，使用我们的
      'omo.wisdom.accumulation' // 禁用 OmO 的 Wisdom，使用 hindsight_reflect
    ]
  },
  
  skillMode: {
    skillName: 'long-term-memory',
    autoInject: true,
    injectTiming: 'pre-task'
  },
  
  agentIsolation: {
    enabled: true,
    sharedTiers: ['permanent', 'project'],
    isolatedTiers: ['session', 'agent']
  },
  
  wisdomIntegration: {
    enabled: true,
    syncToOmO: true,
    useOmOWisdom: false,
    conflictResolution: 'merge'
  },
  
  tokenBudgetCoordination: {
    enabled: true,
    respectOmOBudget: true,
    budgetAllocation: 'equal',
    maxOmOContextRatio: 0.7
  }
};

// 带 Agent 上下文的记忆查询
export interface OmOMemoryQuery {
  query: string;
  sessionId: string;
  agentId: string;
  taskId?: string;
  
  // Agent 层级过滤
  agentScope: 'self' | 'siblings' | 'parent' | 'children' | 'all';
  
  // 记忆层级过滤
  tierFilter?: ('permanent' | 'project' | 'session' | 'agent')[];
  
  // 是否包含 OmO Wisdom
  includeOmOWisdom?: boolean;
  
  // 检索策略
  strategies?: ('semantic' | 'bm25' | 'graph' | 'temporal')[];
}

// OmO 记忆注入结果
export interface OmOMemoryInjection {
  agentId: string;
  taskId?: string;
  injectedMemories: string[];
  tokenCount: number;
  sourceTiers: Record<string, number>;
  
  // 与 OmO 的协调信息
  omOBudgetReserved: number;
  coordinationApplied: boolean;
}

// OmO 反思结果（与 OmO Wisdom 格式兼容）
export interface OmOReflectionResult {
  reflectionId: string;
  agentId: string;
  sessionId: string;
  
  // 标准 hindsight_reflect 字段
  patterns: Array<{
    patternType: string;
    description: string;
    confidence: number;
    sourceObservationIds: string[];
  }>;
  
  // OmO Wisdom 兼容字段
  wisdomEntry?: {
    id: string;
    type: 'pattern' | 'insight' | 'lesson';
    content: string;
    metadata: {
      source: 'pg-memory-hindsight';
      agentId: string;
      timestamp: string;
      confidence: number;
    };
  };
}

// OmO 事件负载类型
export interface OmOTaskCreatedEvent {
  taskId: string;
  sessionId: string;
  agentId: string;
  taskType: string;
  parentTaskId?: string;
  contextSnapshot?: any;
}

export interface OmOTaskCompletedEvent {
  taskId: string;
  sessionId: string;
  agentId: string;
  result: any;
  durationMs: number;
  observationsCount: number;
}

export interface OmOAgentSpawnedEvent {
  agentId: string;
  parentAgentId?: string;
  sessionId: string;
  role: string;
  initialContext?: any;
}

// OmO 与 DCP 的协调状态
export interface OmODCPCoordination {
  omODCPEnabled: boolean;
  pgMemoryDCPEnabled: boolean;
  coordinationMode: 'omo-only' | 'pg-memory-only' | 'coordinated';
  
  // 当前激活的 DCP 实现
  activeDCPProvider: 'omo' | 'pg-memory' | 'none';
  
  // 共享的压缩状态
  sharedCompactionState?: {
    compactedMessageIds: string[];
    preservedMessageIds: string[];
    timestamp: Date;
  };
}