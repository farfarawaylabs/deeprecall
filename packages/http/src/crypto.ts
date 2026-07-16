// Shared hashing/comparison primitives for API-key handling.
//
// sha256Hex derives the API-key lookup index (apikey:<hash>). Management
// hashes the generated key to store it; memory-api hashes the presented key
// to look it up. Both sides importing THIS function is what guarantees the
// two derivations can never diverge (they used to be per-worker copies with
// a "must stay byte-for-byte identical" warning comment).
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const encoder = new TextEncoder();

/** Constant-time string comparison to prevent timing attacks. */
export function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.byteLength !== bBytes.byteLength) return false;

  // Use XOR comparison to avoid early exit on mismatch
  let result = 0;
  for (let i = 0; i < aBytes.byteLength; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }
  return result === 0;
}
