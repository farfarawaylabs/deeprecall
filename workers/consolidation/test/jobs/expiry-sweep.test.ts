import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runExpirySweep } from '../../src/jobs/expiry-sweep';

function makeMockData() {
  return {
    memoryUpdateStatus: vi.fn().mockResolvedValue(undefined),
    vectorDelete: vi.fn().mockResolvedValue(undefined),
    auditLog: vi.fn().mockResolvedValue(undefined),
    idempotencyCleanup: vi.fn().mockResolvedValue(0),
  } as any;
}

describe('runExpirySweep', () => {
  let data: ReturnType<typeof makeMockData>;

  beforeEach(() => {
    data = makeMockData();
  });

  it('cleans up expired idempotency keys', async () => {
    data.idempotencyCleanup.mockResolvedValue(5);

    const result = await runExpirySweep(data, 'default');

    expect(result.idempotency_cleaned).toBe(5);
    expect(data.idempotencyCleanup).toHaveBeenCalledWith('default');
  });

  it('never destroys memory records or vectors', async () => {
    const result = await runExpirySweep(data, 'default');

    expect(result.expired_count).toBe(0);
    expect(data.memoryUpdateStatus).not.toHaveBeenCalled();
    expect(data.vectorDelete).not.toHaveBeenCalled();
  });
});
