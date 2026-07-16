import { Hono } from 'hono';
import { createAdminKeyAuth, createErrorHandler, createLoggingMiddleware } from '@deeprecall/http';
import type { AppBindings } from './types';
import { products } from './routes/products';
import { migrations } from './routes/migrations';

const app = new Hono<AppBindings>();

// Global error handler
app.onError(createErrorHandler<AppBindings>('management'));

// Structured logging (must run before auth)
app.use('/*', createLoggingMiddleware<AppBindings>('management'));

// Root health check (no auth required)
app.get('/', (c) => {
  return c.json({ status: 'ok', service: 'management' });
});

// All management routes require admin auth
const admin = new Hono<AppBindings>();
admin.use('/*', createAdminKeyAuth<AppBindings>());
admin.route('/products', products);
admin.route('/migrations', migrations);
app.route('/admin', admin);

export default app;
