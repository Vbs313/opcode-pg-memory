import { createLogger } from './logger';

const logger = createLogger('agent-context');

export interface AgentCapability {
  role: string;
  share: string[];
}

export const AGENT_CAPABILITIES: Record<string, AgentCapability> = {
  sisyphus:              { role: 'general',    share: ['sisyphus-junior'] },
  hephaestus:            { role: 'build',      share: ['sisyphus'] },
  oracle:                { role: 'reasoning',  share: ['sisyphus', 'metis'] },
  librarian:             { role: 'search',     share: ['sisyphus', 'explore'] },
  explore:               { role: 'discovery',  share: ['sisyphus', 'librarian'] },
  'multimodal-looker':   { role: 'vision',     share: ['sisyphus'] },
  prometheus:            { role: 'plan',       share: ['sisyphus', 'atlas'] },
  metis:                 { role: 'meta',       share: ['oracle', 'sisyphus'] },
  momus:                 { role: 'creative',   share: ['sisyphus'] },
  atlas:                 { role: 'navigate',   share: ['sisyphus', 'prometheus'] },
  'sisyphus-junior':     { role: 'execute',    share: ['sisyphus'] },
};

export function detectAgentId(): string | null {
  const agent = process.env['OMO_AGENT_ID'] ?? process.env['OPENCODE_AGENT'] ?? null;
  if (agent && !AGENT_CAPABILITIES[agent]) {
    logger.warn(`Unknown agent: ${agent}, expected one of: ${Object.keys(AGENT_CAPABILITIES).join(', ')}`);
  }
  return agent;
}

export function getAgentCapabilities(agentId: string | null): AgentCapability | null {
  if (!agentId) return null;
  return AGENT_CAPABILITIES[agentId] ?? null;
}

export function canAccessMemory(ownerAgent: string | null, requesterAgent: string | null): boolean {
  if (!ownerAgent || !requesterAgent) return true;
  if (ownerAgent === requesterAgent) return true;
  const ownerCaps = AGENT_CAPABILITIES[ownerAgent];
  const requesterCaps = AGENT_CAPABILITIES[requesterAgent];
  return (ownerCaps?.share.includes(requesterAgent) ?? false) ||
         (requesterCaps?.share.includes(ownerAgent) ?? false);
}
