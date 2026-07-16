import type { DataService } from '@deeprecall/worker-data';
import type { MemoryCreateInput, ScopeKeys } from '@deeprecall/db';
import { type ClaudeConfig, consolidateProfile } from '@deeprecall/ai';

const MIN_FACTS_FOR_PROFILE = 3;
const MIN_CONFIDENCE = 0.5;
const MAX_FACTS = 50;

export interface ProfileConsolidationResult {
  profile_created: boolean;
  facts_consolidated: number;
  profile_memory_id: string | null;
}

/**
 * Profile Consolidation Job:
 * Query high-confidence facts for a scope, synthesize into a profile-type memory
 * via LLM, persist the profile, and supersede any existing profile.
 *
 * Disjoint profile pools:
 *   - user-scoped run ({ user_id }): rolls up all user memories (including those
 *     that also carry an agent_id).
 *   - agent-scoped run ({ agent_id }): rolls up ONLY standalone-agent memories
 *     (user_id IS NULL). Memories that carry both user_id and agent_id live
 *     under the user's profile.
 */
export async function runProfileConsolidation(
  scope: ScopeKeys,
  product_id: string,
  data: Service<DataService>,
  claude: ClaudeConfig,
): Promise<ProfileConsolidationResult> {
  if (!scope.user_id && !scope.agent_id) {
    throw new Error(
      'runProfileConsolidation: scope must include at least one of user_id or agent_id',
    );
  }

  // Find high-confidence facts for this scope (strict + disjoint-pool rule
  // in the repository — see memory-repository.ts#findFactsForProfile).
  const facts = await data.memoryFindFactsForProfile(product_id, scope, MIN_CONFIDENCE, MAX_FACTS);

  if (facts.length < MIN_FACTS_FOR_PROFILE) {
    return {
      profile_created: false,
      facts_consolidated: 0,
      profile_memory_id: null,
    };
  }

  // Synthesize profile via LLM
  const profileContent = await consolidateProfile(facts, {
    claude,
  });

  // Generate embedding for the profile
  const embeddings = await data.generateEmbeddings([profileContent]);
  const embedding = embeddings[0];
  if (!embedding) {
    throw new Error('Failed to generate embedding for consolidated profile');
  }

  // Find and supersede any existing profile for this exact scope.
  // Relaxed listByScope is fine here — existing user-profile rows don't carry
  // agent_id, and agent-profile rows have user_id IS NULL, so the returned
  // list naturally separates.
  const existingProfiles = await data.memoryListByScope(
    product_id,
    { ...scope, type: 'profile', status: 'active' },
    { limit: 10 },
  );

  const profileId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Propagate only the keys that identify this profile pool. An agent-only
  // profile MUST NOT carry a user_id — otherwise a later user consolidation
  // would erroneously include it.
  const profileUserId = scope.user_id ?? null;
  const profileAgentId = scope.user_id ? null : (scope.agent_id ?? null);

  // Create new profile memory
  const profileInput: MemoryCreateInput = {
    id: profileId,
    content: profileContent,
    episode: null,
    type: 'profile',
    status: 'active',
    user_id: profileUserId,
    agent_id: profileAgentId,
    session_id: null,
    source_actor: 'system',
    source_type: 'system_imported',
    source_channel: 'manual',
    confidence: 1.0,
    document_id: null,
    validity_start: null,
    validity_end: null,
    observed_at: now,
    tags: ['auto_profile'],
    subject: null,
    predicate: null,
    object: null,
  };

  const profileMemory = await data.memoryCreate(product_id, profileInput);

  // Upsert vector — omit any scope key that isn't set on the profile.
  const vectorMetadata: {
    user_id?: string;
    agent_id?: string;
    type: string;
    status: string;
    source_type: string;
    confidence: number;
  } = {
    type: 'profile',
    status: 'active',
    source_type: 'system_imported',
    confidence: 1.0,
  };
  if (profileUserId) vectorMetadata.user_id = profileUserId;
  if (profileAgentId) vectorMetadata.agent_id = profileAgentId;
  await data.vectorUpsert(product_id, profileId, embedding, vectorMetadata);

  // Supersede existing profiles within the same pool. Filter defensively:
  // relaxed listByScope could surface profiles that don't strictly belong to
  // this pool when both scope keys are set on the caller side.
  for (const oldProfile of existingProfiles.items) {
    if (!profileUserId && oldProfile.user_id !== null) continue; // agent-run: skip user profiles
    if (profileUserId && oldProfile.user_id !== profileUserId) continue; // wrong user
    if (!profileUserId && oldProfile.agent_id !== profileAgentId) continue; // wrong agent
    await data.memoryUpdateStatus(product_id, oldProfile.id, 'superseded', profileId);
    await data.vectorDelete(product_id, oldProfile.id);
    await data.auditLog(
      product_id,
      'superseded',
      oldProfile.id,
      'Superseded by new consolidated profile',
      oldProfile,
      null,
      'consolidation',
    );
  }

  // Audit the new profile
  await data.auditLog(
    product_id,
    'created',
    profileId,
    `Consolidated profile from ${facts.length} facts`,
    null,
    profileMemory,
    'consolidation',
  );

  return {
    profile_created: true,
    facts_consolidated: facts.length,
    profile_memory_id: profileId,
  };
}
