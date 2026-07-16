import type { LogLevel, LogContext, LogEntry, AxiomConfig } from './types';
import { sendToAxiom } from './axiom';

/**
 * Static Logger class for structured logging across all services.
 * Dual output: console (Cloudflare-compatible) + Axiom (HTTP POST).
 *
 * Each LogContext carries its own buffer to prevent cross-request log
 * contamination in Workers (multiple concurrent requests share the isolate).
 *
 * Usage:
 *   const ctx = Logger.createContext("memory-api", { product_id: "default" });
 *   Logger.info(ctx, "Request received", { path: "/v1/ingest" });
 *   await Logger.flush(ctx, axiomConfig);
 */
export class Logger {
  /** Generate a new trace ID for request correlation. */
  static generateTraceId(): string {
    return crypto.randomUUID();
  }

  /** Create a log context for a request/operation. */
  static createContext(service: string, overrides: Partial<LogContext> = {}): LogContext {
    return {
      service,
      trace_id: overrides.trace_id ?? Logger.generateTraceId(),
      _buffer: [],
      ...overrides,
    };
  }

  /** Create a child context inheriting the parent's trace_id and buffer but adding a step. */
  static childContext(parent: LogContext, step: string): LogContext {
    return { ...parent, step };
  }

  static debug(ctx: LogContext, message: string, extra?: Record<string, unknown>): void {
    Logger.log('debug', ctx, message, extra);
  }

  static info(ctx: LogContext, message: string, extra?: Record<string, unknown>): void {
    Logger.log('info', ctx, message, extra);
  }

  static warn(ctx: LogContext, message: string, extra?: Record<string, unknown>): void {
    Logger.log('warn', ctx, message, extra);
  }

  static error(ctx: LogContext, message: string, extra?: Record<string, unknown>): void {
    Logger.log('error', ctx, message, extra);
  }

  /**
   * Flush buffered log entries to Axiom.
   * Call this at the end of a request (e.g., in waitUntil).
   * If no Axiom config is provided, the buffer is just cleared.
   */
  static async flush(ctx: LogContext, axiomConfig?: AxiomConfig): Promise<void> {
    const entries = ctx._buffer.splice(0);
    if (axiomConfig && entries.length > 0) {
      await sendToAxiom(entries, axiomConfig);
    }
  }

  /** Measure the duration of an async operation. */
  static async timed<T>(ctx: LogContext, label: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      Logger.info(ctx, `${label} completed`, {
        duration_ms: Date.now() - start,
      });
      return result;
    } catch (err) {
      Logger.error(ctx, `${label} failed`, {
        duration_ms: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private static log(
    level: LogLevel,
    ctx: LogContext,
    message: string,
    extra?: Record<string, unknown>,
  ): void {
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      service: ctx.service,
      trace_id: ctx.trace_id,
      ...(ctx.product_id && { product_id: ctx.product_id }),
      ...(ctx.user_id && { user_id: ctx.user_id }),
      ...(ctx.step && { step: ctx.step }),
      ...extra,
    };

    // Console output (always)
    const consoleFn =
      level === 'error'
        ? console.error
        : level === 'warn'
          ? console.warn
          : level === 'debug'
            ? console.debug
            : console.log;
    consoleFn(JSON.stringify(entry));

    // Buffer for Axiom (per-request)
    ctx._buffer.push(entry);
  }
}
