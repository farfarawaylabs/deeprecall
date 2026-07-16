import { describe, it, expect } from 'vitest';
import { resolveFileType, extractFileText } from '../../src/documents/file-type';

// Characterization tests written BEFORE the C1 extraction: they pin the
// current MIME/filename resolution matrix and text decoding behavior so the
// refactor can be verified as behavior-preserving. Only the import path
// should change when the logic moves to src/documents/.

describe('resolveFileType', () => {
  it('resolves application/pdf regardless of filename', () => {
    expect(resolveFileType('application/pdf', 'report.pdf')).toBe('pdf');
    expect(resolveFileType('application/pdf', null)).toBe('pdf');
    expect(resolveFileType('application/pdf', 'weird.md')).toBe('pdf');
  });

  it('resolves markdown MIME types', () => {
    expect(resolveFileType('text/markdown', 'notes.md')).toBe('markdown');
    expect(resolveFileType('text/x-markdown', 'notes')).toBe('markdown');
  });

  it('resolves markdown by extension even when MIME says text/plain', () => {
    expect(resolveFileType('text/plain', 'notes.md')).toBe('markdown');
    expect(resolveFileType('text/plain', 'notes.markdown')).toBe('markdown');
    expect(resolveFileType('application/octet-stream', 'notes.md')).toBe('markdown');
  });

  it('resolves application/json regardless of filename', () => {
    expect(resolveFileType('application/json', 'data.json')).toBe('json');
    expect(resolveFileType('application/json', 'data.bin')).toBe('json');
  });

  it('resolves any text/* MIME to text', () => {
    expect(resolveFileType('text/plain', 'a.txt')).toBe('text');
    expect(resolveFileType('text/csv', 'a.csv')).toBe('text');
    expect(resolveFileType('text/html', 'a.html')).toBe('text');
  });

  it('falls back to extension for missing or octet-stream MIME', () => {
    expect(resolveFileType(null, 'a.txt')).toBe('text');
    expect(resolveFileType('', 'a.txt')).toBe('text');
    expect(resolveFileType('application/octet-stream', 'a.txt')).toBe('text');
    expect(resolveFileType('application/octet-stream', 'a.json')).toBe('json');
    expect(resolveFileType(undefined, 'a.json')).toBe('json');
  });

  it('is case-insensitive on MIME and filename', () => {
    expect(resolveFileType('APPLICATION/PDF', 'x')).toBe('pdf');
    expect(resolveFileType('text/plain', 'NOTES.MD')).toBe('markdown');
    expect(resolveFileType(null, 'A.TXT')).toBe('text');
  });

  it('rejects unsupported combinations with null', () => {
    expect(resolveFileType('image/png', 'a.png')).toBeNull();
    expect(resolveFileType('application/octet-stream', 'a.exe')).toBeNull();
    expect(resolveFileType('application/octet-stream', null)).toBeNull();
    expect(resolveFileType(null, null)).toBeNull();
    expect(resolveFileType('application/zip', 'a.zip')).toBeNull();
  });
});

describe('extractFileText (non-PDF paths)', () => {
  const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

  it('decodes text, markdown, and json buffers as UTF-8', async () => {
    expect(await extractFileText('text', enc('hello world'))).toBe('hello world');
    expect(await extractFileText('markdown', enc('# Title\n\nBody'))).toBe('# Title\n\nBody');
    expect(await extractFileText('json', enc('{"a":1}'))).toBe('{"a":1}');
  });

  it('preserves multibyte characters', async () => {
    expect(await extractFileText('text', enc('héllo עולם 日本語'))).toBe('héllo עולם 日本語');
  });

  it('returns an empty string for an empty buffer (caller treats as no content)', async () => {
    expect(await extractFileText('text', new ArrayBuffer(0))).toBe('');
  });
});
