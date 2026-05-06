const CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;
const INLINE_CODE_PATTERN = /`[^`]+`/g;

const DEFAULT_KEYWORDS = [
  'remember', 'memorize', 'save\\s+this', 'note\\s+this',
  'keep\\s+in\\s+mind', "don'?t\\s+forget", 'learn\\s+this',
  'store\\s+this', 'record\\s+this', 'make\\s+a\\s+note',
  'take\\s+note', 'jot\\s+down', 'commit\\s+to\\s+memory',
  'remember\\s+that', 'never\\s+forget', 'always\\s+remember',
];

const MEMORY_KEYWORD_RE = new RegExp(
  `\\b(${DEFAULT_KEYWORDS.join('|')})\\b`, 'i'
);

export function removeCodeBlocks(text: string): string {
  return text.replace(CODE_BLOCK_PATTERN, '').replace(INLINE_CODE_PATTERN, '');
}

export function detectMemoryKeyword(text: string): boolean {
  if (!text) return false;
  return MEMORY_KEYWORD_RE.test(removeCodeBlocks(text));
}

export const MEMORY_NUDGE_MESSAGE = `[MEMORY TRIGGER DETECTED]
The user wants you to remember something important.
Consider using the following tools to persist this knowledge:
- recall_memory: to retrieve related context
- The pg-memory plugin will automatically record this session's observations for future use.`;
