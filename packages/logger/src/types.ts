export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  service: string;
  trace_id: string;
  product_id?: string;
  user_id?: string;
  step?: string;
  /** Per-request log buffer — prevents cross-request contamination in Workers isolates. */
  _buffer: LogEntry[];
  [key: string]: unknown;
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  service: string;
  trace_id: string;
  product_id?: string;
  user_id?: string;
  step?: string;
  duration_ms?: number;
  timestamp: string;
  [key: string]: unknown;
}

export interface AxiomConfig {
  apiToken: string;
  dataset: string;
}
