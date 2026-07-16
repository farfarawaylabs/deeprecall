import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '../logger';

describe('Logger', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  describe('createContext', () => {
    it('creates context with service and auto-generated trace_id', () => {
      const ctx = Logger.createContext('memory-api');
      expect(ctx.service).toBe('memory-api');
      expect(ctx.trace_id).toBeDefined();
      expect(ctx.trace_id.length).toBeGreaterThan(0);
    });

    it('creates context with provided overrides', () => {
      const ctx = Logger.createContext('ingestion', {
        trace_id: 'custom-trace',
        product_id: 'default',
        user_id: 'user-123',
      });
      expect(ctx.service).toBe('ingestion');
      expect(ctx.trace_id).toBe('custom-trace');
      expect(ctx.product_id).toBe('default');
      expect(ctx.user_id).toBe('user-123');
    });
  });

  describe('childContext', () => {
    it('inherits trace_id and adds step', () => {
      const parent = Logger.createContext('ingestion', {
        trace_id: 'trace-abc',
        product_id: 'default',
      });
      const child = Logger.childContext(parent, 'extract');
      expect(child.trace_id).toBe('trace-abc');
      expect(child.product_id).toBe('default');
      expect(child.step).toBe('extract');
    });
  });

  describe('log methods', () => {
    it('info logs structured JSON to console', () => {
      const ctx = Logger.createContext('test', { trace_id: 't-1' });
      Logger.info(ctx, 'Test message', { key: 'value' });

      expect(consoleSpy).toHaveBeenCalledOnce();
      const logged = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(logged.level).toBe('info');
      expect(logged.message).toBe('Test message');
      expect(logged.service).toBe('test');
      expect(logged.trace_id).toBe('t-1');
      expect(logged.key).toBe('value');
      expect(logged.timestamp).toBeDefined();
    });

    it('error logs to console.error', () => {
      const errorSpy = vi.spyOn(console, 'error');
      const ctx = Logger.createContext('test', { trace_id: 't-2' });
      Logger.error(ctx, 'Something broke');

      // console.error is called (the mock from beforeEach catches it)
      expect(errorSpy).toHaveBeenCalled();
      const logged = JSON.parse(errorSpy.mock.calls[0][0] as string);
      expect(logged.level).toBe('error');
    });

    it('warn logs to console.warn', () => {
      const warnSpy = vi.spyOn(console, 'warn');
      const ctx = Logger.createContext('test', { trace_id: 't-3' });
      Logger.warn(ctx, 'Watch out');

      expect(warnSpy).toHaveBeenCalled();
      const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
      expect(logged.level).toBe('warn');
    });

    it('excludes undefined optional fields', () => {
      const ctx = Logger.createContext('test', { trace_id: 't-4' });
      Logger.info(ctx, 'No extras');

      const logged = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(logged).not.toHaveProperty('product_id');
      expect(logged).not.toHaveProperty('user_id');
      expect(logged).not.toHaveProperty('step');
    });

    it('includes product_id and user_id when set', () => {
      const ctx = Logger.createContext('test', {
        trace_id: 't-5',
        product_id: 'prod-1',
        user_id: 'user-1',
      });
      Logger.info(ctx, 'With scope');

      const logged = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(logged.product_id).toBe('prod-1');
      expect(logged.user_id).toBe('user-1');
    });
  });

  describe('generateTraceId', () => {
    it('generates unique UUIDs', () => {
      const id1 = Logger.generateTraceId();
      const id2 = Logger.generateTraceId();
      expect(id1).not.toBe(id2);
      // UUID v4 format
      expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
  });

  describe('timed', () => {
    it('measures success duration', async () => {
      const ctx = Logger.createContext('test', { trace_id: 't-6' });
      const result = await Logger.timed(ctx, 'operation', async () => {
        return 42;
      });

      expect(result).toBe(42);
      expect(consoleSpy).toHaveBeenCalled();
      const logged = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(logged.message).toBe('operation completed');
      expect(logged.duration_ms).toBeTypeOf('number');
    });

    it('measures failure duration and rethrows', async () => {
      const errorSpy = vi.spyOn(console, 'error');
      const ctx = Logger.createContext('test', { trace_id: 't-7' });

      await expect(
        Logger.timed(ctx, 'failing-op', async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(errorSpy).toHaveBeenCalled();
      const logged = JSON.parse(errorSpy.mock.calls[0][0] as string);
      expect(logged.message).toBe('failing-op failed');
      expect(logged.error).toBe('boom');
      expect(logged.duration_ms).toBeTypeOf('number');
    });
  });
});
