import { describe, it, expect } from 'vitest';
import { sha256Hex, timingSafeEqual } from '../crypto';

describe('sha256Hex', () => {
  it('produces the known SHA-256 hex digest', async () => {
    // Known vector: sha256("abc")
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('produces 64 lowercase hex chars for any input', async () => {
    expect(await sha256Hex('')).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex(crypto.randomUUID())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('timingSafeEqual', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqual('secret-key', 'secret-key')).toBe(true);
  });

  it('returns false for different strings of equal length', () => {
    expect(timingSafeEqual('secret-key', 'secret-keX')).toBe(false);
  });

  it('returns false for different lengths', () => {
    expect(timingSafeEqual('short', 'longer-string')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
    expect(timingSafeEqual('', 'x')).toBe(false);
  });
});
