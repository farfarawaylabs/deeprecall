// Repository interfaces
export type {
  IMemoryRepository,
  IAuditRepository,
  IIdempotencyRepository,
  IDeadLetterRepository,
  IDocumentRepository,
  MemoryCreateInput,
  MemoryListFilters,
  PaginationParams,
  PaginatedResult,
  AuditEntry,
  DeadLetterEntry,
  DocumentCreateInput,
  DocumentUpdateInput,
  DocumentListFilters,
  DocumentCleanupRef,
  ScopeKeys,
} from './interfaces';

// Canonical schema + migration exports (raw SQL never lives outside this package)
export {
  INITIAL_SCHEMA_SQL,
  MIGRATION_STEPS,
  BASELINE_SCHEMA_VERSION,
  LATEST_SCHEMA_VERSION,
  SCHEMA_VERSION_SQL,
  getPendingVersions,
  latestVersion,
} from './schema';

// D1 implementations
export { D1MemoryRepository } from './repositories/memory-repository';
export { D1AuditRepository } from './repositories/audit-repository';
export { D1IdempotencyRepository } from './repositories/idempotency-repository';
export { D1DeadLetterRepository } from './repositories/dead-letter-repository';
export { D1DocumentRepository } from './repositories/document-repository';
