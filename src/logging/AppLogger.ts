export type LogLevel = 'error' | 'info' | 'debug';

interface LoggerSink {
  info?: (message: string) => void;
  error?: (message: string) => void;
}

interface AppLoggerOptions {
  level?: LogLevel | string | undefined;
  sink?: LoggerSink;
  clock?: () => Date;
  maxValueLength?: number;
}

export interface AppLogger {
  error(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  debug(event: string, fields?: Record<string, unknown>): void;
  level: LogLevel;
}

const DEFAULT_LOG_LEVEL: LogLevel = 'info';
const DEFAULT_MAX_VALUE_LENGTH = 80;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  info: 1,
  debug: 2,
};

export function createAppLogger(options: AppLoggerOptions = {}): AppLogger {
  const level = parseLogLevel(process.env.LOG_LEVEL ?? options.level);
  const sink = {
    info: options.sink?.info ?? console.info.bind(console),
    error: options.sink?.error ?? console.error.bind(console),
  };
  const clock = options.clock ?? (() => new Date());
  const maxValueLength = options.maxValueLength ?? DEFAULT_MAX_VALUE_LENGTH;

  const shouldLog = (messageLevel: LogLevel) => LEVEL_PRIORITY[messageLevel] <= LEVEL_PRIORITY[level];
  const emit = (messageLevel: LogLevel, event: string, fields: Record<string, unknown> = {}) => {
    if (!shouldLog(messageLevel)) {
      return;
    }
    const line = formatLogLine(clock(), messageLevel, event, fields, maxValueLength);
    if (messageLevel === 'error') {
      sink.error(line);
      return;
    }
    sink.info(line);
  };

  return {
    level,
    error: (event, fields) => emit('error', event, fields),
    info: (event, fields) => emit('info', event, fields),
    debug: (event, fields) => emit('debug', event, fields),
  };
}

export function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'error' || normalized === 'info' || normalized === 'debug') {
    return normalized;
  }
  return DEFAULT_LOG_LEVEL;
}

function formatLogLine(at: Date, level: LogLevel, event: string, fields: Record<string, unknown>, maxValueLength: number): string {
  const timestamp = at.toISOString().replace('T', ' ').slice(0, 19);
  const levelToken = level.toUpperCase().padEnd(5, ' ');
  const renderedFields = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatFieldValue(value, maxValueLength)}`)
    .join(' ');
  return renderedFields.length > 0
    ? `[${timestamp}] ${levelToken} ${event} ${renderedFields}`
    : `[${timestamp}] ${levelToken} ${event}`;
}

function formatFieldValue(value: unknown, maxValueLength: number): string {
  if (typeof value === 'string') {
    return formatStringValue(value, maxValueLength);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === null) {
    return 'null';
  }
  return formatStringValue(JSON.stringify(value), maxValueLength);
}

function formatStringValue(value: string, maxValueLength: number): string {
  const truncated = truncateValue(value.replace(/\s+/g, ' ').trim(), maxValueLength);
  return /[\s=]/.test(truncated) ? `"${truncated}"` : truncated;
}

function truncateValue(value: string, maxValueLength: number): string {
  if (value.length <= maxValueLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxValueLength - 1))}…`;
}
