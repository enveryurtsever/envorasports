type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL: Level = process.env.NODE_ENV === 'production' ? 'info' : 'debug';

export interface LogContext {
  [key: string]: unknown;
}

function emit(level: Level, scope: string, message: string, context?: LogContext) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
  const payload = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(context ?? {}),
  };
  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** Structured, greppable logs. Never log API keys or connection strings. */
export function createLogger(scope: string) {
  return {
    debug: (message: string, context?: LogContext) => emit('debug', scope, message, context),
    info: (message: string, context?: LogContext) => emit('info', scope, message, context),
    warn: (message: string, context?: LogContext) => emit('warn', scope, message, context),
    error: (message: string, context?: LogContext) => emit('error', scope, message, context),
    child: (childScope: string) => createLogger(`${scope}:${childScope}`),
  };
}

export type Logger = ReturnType<typeof createLogger>;
