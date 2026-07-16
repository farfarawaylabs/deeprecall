import { apiError } from '@deeprecall/http';
import { Hono } from 'hono';
import { CorrectionRequest } from '@deeprecall/types';
import type { AppBindings } from '../types';
import { applyCorrection } from '../corrections/corrections-service';
import { CorrectionRequestError } from '../corrections/errors';

export const correct = new Hono<AppBindings>();

/**
 * POST /v1/correct
 * Apply a user correction (suppress/expire/delete/pin/update) to a memory.
 */
correct.post('/', async (c) => {
  const body = await c.req.json();
  const parsed = CorrectionRequest.safeParse(body);

  if (!parsed.success) {
    return apiError(
      c,
      400,
      'VALIDATION_ERROR',
      'Invalid correction request',
      parsed.error.flatten(),
    );
  }

  try {
    const result = await applyCorrection(parsed.data, {
      env: c.env,
      productId: c.get('product_id'),
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof CorrectionRequestError) {
      return apiError(c, err.status, err.code, err.message);
    }
    throw err;
  }
});
