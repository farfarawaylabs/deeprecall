import type { LogEntry, AxiomConfig } from './types';

const AXIOM_INGEST_URL = 'https://api.axiom.co/v1/datasets';

/**
 * Ships structured log entries to Axiom via HTTP POST.
 * Designed for Cloudflare Workers — uses the global fetch API.
 * Batches entries for efficiency.
 */
export async function sendToAxiom(entries: LogEntry[], config: AxiomConfig): Promise<void> {
  if (entries.length === 0) return;

  try {
    const response = await fetch(`${AXIOM_INGEST_URL}/${config.dataset}/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiToken}`,
      },
      body: JSON.stringify(entries),
    });

    if (!response.ok) {
      // Log the failure to console but don't throw — logging should never break the app
      console.error(`[Logger] Axiom ingest failed: ${response.status} ${response.statusText}`);
    }
  } catch {
    // Swallow network errors — logging must not break the caller
    console.error('[Logger] Axiom ingest network error');
  }
}
