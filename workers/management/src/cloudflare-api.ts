const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

interface D1CreateResult {
  uuid: string;
  name: string;
}

interface VectorizeCreateResult {
  name: string;
}

export type VectorizeMetadataIndexType = 'string' | 'number' | 'boolean';

interface VectorizeMetadataIndexResult {
  mutationId?: string;
}

interface CloudflareApiResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
  result: T;
}

/**
 * Cloudflare REST API client for provisioning D1 databases and Vectorize indexes.
 * Uses the Cloudflare API token from secrets for authentication.
 */
export class CloudflareApiClient {
  private readonly apiToken: string;
  private readonly accountId: string;

  constructor(apiToken: string, accountId: string) {
    this.apiToken = apiToken;
    this.accountId = accountId;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${CLOUDFLARE_API_BASE}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json',
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = (await response.json()) as CloudflareApiResponse<T>;

    if (!data.success) {
      const errorMessages = data.errors.map((e) => `[${e.code}] ${e.message}`).join('; ');
      throw new Error(`Cloudflare API error: ${errorMessages}`);
    }

    return data.result;
  }

  /**
   * Create a new D1 database.
   * POST /accounts/{account_id}/d1/database
   */
  async createD1Database(name: string): Promise<D1CreateResult> {
    return this.request<D1CreateResult>('POST', `/accounts/${this.accountId}/d1/database`, {
      name,
    });
  }

  /**
   * Create a new Vectorize index.
   * POST /accounts/{account_id}/vectorize/v2/indexes
   */
  async createVectorizeIndex(
    name: string,
    dimensions: number,
    metric: string,
  ): Promise<VectorizeCreateResult> {
    return this.request<VectorizeCreateResult>(
      'POST',
      `/accounts/${this.accountId}/vectorize/v2/indexes`,
      {
        name,
        config: {
          dimensions,
          metric,
        },
      },
    );
  }

  /**
   * Delete a D1 database.
   * DELETE /accounts/{account_id}/d1/database/{database_id}
   */
  async deleteD1Database(databaseId: string): Promise<void> {
    await this.request<unknown>('DELETE', `/accounts/${this.accountId}/d1/database/${databaseId}`);
  }

  /**
   * Create a metadata index on a Vectorize index. Metadata indexes are required
   * for `.query({ filter: { ... } })` to return matches — without them, filtered
   * queries silently return zero results. Creation is async on Cloudflare's side
   * (typically ready within a few seconds); up to 10 metadata indexes allowed per
   * Vectorize index.
   *
   * POST /accounts/{account_id}/vectorize/v2/indexes/{index_name}/metadata_index/create
   */
  async createVectorizeMetadataIndex(
    indexName: string,
    propertyName: string,
    type: VectorizeMetadataIndexType,
  ): Promise<VectorizeMetadataIndexResult> {
    return this.request<VectorizeMetadataIndexResult>(
      'POST',
      `/accounts/${this.accountId}/vectorize/v2/indexes/${indexName}/metadata_index/create`,
      { propertyName, indexType: type },
    );
  }

  /**
   * Delete a Vectorize index.
   * DELETE /accounts/{account_id}/vectorize/v2/indexes/{index_name}
   */
  async deleteVectorizeIndex(indexName: string): Promise<void> {
    await this.request<unknown>(
      'DELETE',
      `/accounts/${this.accountId}/vectorize/v2/indexes/${indexName}`,
    );
  }

  /**
   * Execute SQL on a D1 database via the REST API.
   * POST /accounts/{account_id}/d1/database/{database_id}/query
   */
  async executeD1Sql(databaseId: string, sql: string): Promise<unknown> {
    return this.request<unknown>(
      'POST',
      `/accounts/${this.accountId}/d1/database/${databaseId}/query`,
      { sql },
    );
  }
}
