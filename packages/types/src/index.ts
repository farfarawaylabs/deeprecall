// Enums
export {
  MemoryType,
  MemoryStatus,
  SourceType,
  SourceChannel,
  SceneType,
  FileType,
  AuditAction,
  AuditTrigger,
} from './enums';

// Core types
export { Memory, MemoryCandidate } from './memory';
export { Scope } from './scope';
export { JsonValue } from './json';

// API schemas
export {
  IngestionRequest,
  IngestionResponse,
  QueryRequest,
  QueryResponse,
  ScoredMemory,
  RetrievalMode,
  AnswerRequest,
  AnswerResponse,
  HealthResponse,
  CorrectionAction,
  CorrectionRequest,
  CorrectionResponse,
} from './api';

// Consolidation types
export { ConsolidationMessageType, ConsolidationMessage, DeadLetter } from './consolidation';

// Document types
export {
  Document,
  DocumentUploadRequest,
  DocumentUploadResponse,
  DocumentResponse,
  DocumentListQuery,
  DocumentListResponse,
  DocumentDeleteResponse,
  DocumentPurgeRequest,
  DocumentPurgeDryRunResponse,
} from './document';

// Purge types
export {
  PurgeScope,
  PurgeRequest,
  PurgeAllRequest,
  PurgeMessageType,
  PurgeMessage,
  PurgeJobStatusValue,
  PurgeJobStatus,
  PurgeAcceptedResponse,
  PurgeDryRunResponse,
} from './purge';

// Error types
export { ApiError, ErrorCode } from './errors';
