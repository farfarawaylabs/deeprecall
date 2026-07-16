import { z } from 'zod';

export const Scope = z
  .object({
    user_id: z.string().min(1).optional(),
    agent_id: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
  })
  .refine((s) => !!s.user_id || !!s.agent_id, {
    message: 'scope must include at least one of user_id or agent_id',
    path: ['user_id'],
  });
export type Scope = z.infer<typeof Scope>;
