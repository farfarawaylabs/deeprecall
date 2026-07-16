import { describe, it, expect } from 'vitest';
import { parseDocumentUpload, type MultipartBody } from '../../src/documents/multipart';
import { DocumentRequestError } from '../../src/documents/errors';

const DEFAULTS = { document_type: null, description: null };

function txtFile(content = 'hello world', name = 'a.txt', type = 'text/plain'): File {
  return new File([content], name, { type });
}

function baseBody(overrides: Partial<Record<string, string | File>> = {}): MultipartBody {
  return {
    file: txtFile(),
    scope: JSON.stringify({ user_id: 'u1' }),
    ...overrides,
  } as MultipartBody;
}

async function expectError(
  body: MultipartBody,
  expected: { status: number; code: string; message?: string },
) {
  const err = await parseDocumentUpload(body, DEFAULTS).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(DocumentRequestError);
  const dre = err as DocumentRequestError;
  expect(dre.status).toBe(expected.status);
  expect(dre.code).toBe(expected.code);
  if (expected.message) expect(dre.message).toBe(expected.message);
}

describe('parseDocumentUpload validation', () => {
  it('rejects a missing file field', async () => {
    await expectError(
      { scope: '{"user_id":"u1"}' },
      {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: "Missing or invalid 'file' field. Must be a file upload.",
      },
    );
  });

  it('rejects a string file field', async () => {
    await expectError(baseBody({ file: 'not-a-file' }), {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  });

  it('rejects files over 25 MB with FILE_TOO_LARGE', async () => {
    // Override size so the test does not allocate 25 MB for real.
    const big = txtFile();
    Object.defineProperty(big, 'size', { value: 25 * 1024 * 1024 + 1 });
    await expectError(baseBody({ file: big }), {
      status: 413,
      code: 'FILE_TOO_LARGE',
      message: `File size ${25 * 1024 * 1024 + 1} exceeds maximum of 25 MB`,
    });
  });

  it('rejects a missing scope field', async () => {
    await expectError(
      { file: txtFile() },
      {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: "Missing or invalid 'scope' field. Must be a JSON string.",
      },
    );
  });

  it('rejects malformed scope JSON', async () => {
    await expectError(baseBody({ scope: '{not json' }), {
      status: 400,
      code: 'VALIDATION_ERROR',
      message: "Invalid JSON in 'scope' field.",
    });
  });

  it('rejects a scope failing schema validation, with details attached', async () => {
    const err = await parseDocumentUpload(baseBody({ scope: '{}' }), DEFAULTS).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DocumentRequestError);
    const dre = err as DocumentRequestError;
    expect(dre.status).toBe(400);
    expect(dre.message).toBe('Invalid scope');
    expect(dre.details).toBeDefined();
  });

  it('rejects unsupported file types with the supported-formats message', async () => {
    const png = txtFile('x', 'a.png', 'image/png');
    await expectError(baseBody({ file: png }), {
      status: 422,
      code: 'UNSUPPORTED_CONTENT',
      message:
        "Unsupported file. MIME 'image/png' (filename 'a.png') does not match any supported file type. Supported: pdf, markdown, text, json.",
    });
  });

  it('applies first-error-wins ordering when multiple fields are invalid', async () => {
    // Oversized file AND malformed scope: the size check runs first, so
    // FILE_TOO_LARGE wins over the scope's VALIDATION_ERROR.
    const big = txtFile();
    Object.defineProperty(big, 'size', { value: 25 * 1024 * 1024 + 1 });
    await expectError(baseBody({ file: big, scope: '{not json' }), {
      status: 413,
      code: 'FILE_TOO_LARGE',
    });
    // Malformed scope AND unsupported file type: scope validation runs
    // before file-type resolution.
    const png = txtFile('x', 'a.png', 'image/png');
    await expectError(baseBody({ file: png, scope: '{not json' }), {
      status: 400,
      code: 'VALIDATION_ERROR',
      message: "Invalid JSON in 'scope' field.",
    });
  });

  it('rejects supported files with no extractable text', async () => {
    const empty = txtFile('   \n  ', 'a.txt');
    await expectError(baseBody({ file: empty }), {
      status: 422,
      code: 'UNSUPPORTED_CONTENT',
      message: "File was 'text' but had no extractable text.",
    });
  });
});

describe('parseDocumentUpload field semantics', () => {
  it('returns the parsed upload on the happy path', async () => {
    const result = await parseDocumentUpload(
      baseBody({
        scope: JSON.stringify({ user_id: 'u1', agent_id: 'ag1', session_id: 's1' }),
        document_type: 'transcript',
        description: 'weekly sync',
        scene_type: 'meeting',
        idempotency_key: 'idem-1',
      }),
      DEFAULTS,
    );
    expect(result.scope).toEqual({ user_id: 'u1', agent_id: 'ag1', session_id: 's1' });
    expect(result.documentType).toBe('transcript');
    expect(result.description).toBe('weekly sync');
    expect(result.sceneType).toBe('meeting');
    expect(result.idempotencyKey).toBe('idem-1');
    expect(result.fileType).toBe('text');
    expect(result.textContent).toBe('hello world');
    expect(new TextDecoder().decode(result.r2Buffer)).toBe('hello world');
  });

  it('falls back to the provided defaults when fields are absent', async () => {
    const result = await parseDocumentUpload(baseBody(), {
      document_type: 'existing-type',
      description: 'existing-desc',
    });
    expect(result.documentType).toBe('existing-type');
    expect(result.description).toBe('existing-desc');
  });

  it('clears document_type and description when fields are present but empty', async () => {
    const result = await parseDocumentUpload(baseBody({ document_type: '', description: '' }), {
      document_type: 'existing-type',
      description: 'existing-desc',
    });
    expect(result.documentType).toBeNull();
    expect(result.description).toBeNull();
  });

  it('defaults scene_type to document and idempotency_key to undefined', async () => {
    const result = await parseDocumentUpload(baseBody(), DEFAULTS);
    expect(result.sceneType).toBe('document');
    expect(result.idempotencyKey).toBeUndefined();
  });
});
