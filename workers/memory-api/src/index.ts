import { Hono } from 'hono';
import { createAdminKeyAuth, createErrorHandler, createLoggingMiddleware } from '@deeprecall/http';
import type { AppBindings } from './types';
import { apiKeyAuth } from './middleware/auth';
import { ingest } from './routes/ingest';
import { query } from './routes/query';
import { answer } from './routes/answer';
import { correct } from './routes/correct';
import { inspect } from './routes/inspect';
import { memories } from './routes/memories';
import { documents } from './routes/documents';
import { documentsPurge } from './routes/documents-purge';
import { health } from './routes/health';
import { admin } from './routes/admin';
import { purgeScoped, purgeAll } from './routes/purge';

const app = new Hono<AppBindings>();

// Global error handler
app.onError(createErrorHandler<AppBindings>('memory-api'));

// Structured logging (must run before auth so trace_id is available)
app.use('/*', createLoggingMiddleware<AppBindings>('memory-api'));

// Health check (no auth — accessible to load balancers/monitoring)
app.route('/v1/health', health);

// Public API routes (authenticated via API key)
const v1 = new Hono<AppBindings>();
v1.use('/*', apiKeyAuth);
v1.route('/ingest', ingest);
v1.route('/query', query);
v1.route('/answer', answer);
v1.route('/correct', correct);
v1.route('/inspect', inspect);
v1.route('/memories', memories);
v1.route('/memories/purge', purgeScoped);
v1.route('/memories/purge-all', purgeAll);
// Mount documents/purge BEFORE /documents so the purge sub-routes aren't
// captured by /documents/:document_id dynamic handlers.
v1.route('/documents/purge', documentsPurge);
v1.route('/documents', documents);
app.route('/v1', v1);

// Admin routes (authenticated via admin key)
const adminRoutes = new Hono<AppBindings>();
adminRoutes.use('/*', createAdminKeyAuth<AppBindings>());
adminRoutes.route('/', admin);
app.route('/admin', adminRoutes);

// Root health check (no auth required)
app.get('/', (c) => {
  return c.json({ status: 'ok', service: 'memory-api' });
});

export default app;
