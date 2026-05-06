type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_MAP: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_NAMES: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
};

function getConfiguredLevel(): number {
  const env = process.env.PG_MEMORY_LOG_LEVEL ?? 'info';
  const level = env.toLowerCase() as LogLevel;
  if (level in LEVEL_MAP) {
    return LEVEL_MAP[level];
  }
  return LEVEL_MAP.info;
}

const currentLevel = getConfiguredLevel();

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

function log(level: LogLevel, module: string, msg: string, data?: unknown): void {
  if (currentLevel > LEVEL_MAP[level]) {
    return;
  }

  const line = data !== undefined
    ? `[PG Memory] [${LEVEL_NAMES[level]}] [${module}] ${msg} ${JSON.stringify(data)}\n`
    : `[PG Memory] [${LEVEL_NAMES[level]}] [${module}] ${msg}\n`;

  process.stderr.write(line);
}

export function createLogger(module: string): Logger {
  return {
    debug: (msg: string, data?: unknown) => log('debug', module, msg, data),
    info: (msg: string, data?: unknown) => log('info', module, msg, data),
    warn: (msg: string, data?: unknown) => log('warn', module, msg, data),
    error: (msg: string, data?: unknown) => log('error', module, msg, data),
  };
}
