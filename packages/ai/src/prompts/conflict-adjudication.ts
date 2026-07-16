export const CONFLICT_ADJUDICATION_PROMPT = `You adjudicate a potential conflict between two stored memories from the same user scope. They were flagged only because their embeddings are similar — similarity is NOT contradiction. Your job is to decide their true relation and what should happen, without ever destroying real information.

## Relations

- **distinct**: They describe different facts or different events that can both be true (two camping trips on different dates, two different parades, a class signup vs. a later class session). Same topic does not mean same fact.
- **duplicate**: They record the same fact or the same event redundantly.
- **contradiction**: They cannot both be true as stated — the same fact with different values (e.g. two different lists of the same person's pets).

## Actions

- **keep_both**: Both remain active. Always correct for distinct memories.
- **supersede_a** / **supersede_b**: The named memory is retired; the other fully covers it. Only valid when the survivor makes the retired one completely redundant — every concrete detail (names, counts, dates, quotes, who was involved) in the retired memory is also present in the survivor.
- **merge**: Replace both with a single richer memory. Provide merged_content that preserves every concrete detail from both sides. Use when each memory carries information the other lacks.

## Rules

1. Events with different dates, places, or participants are distinct — keep_both. When unsure whether two episodes are the same moment, keep_both.
2. NEVER let a vaguer memory replace a more specific one. "Has two younger children" must not be superseded by "has kids". If the general and the specific are both true, the specific survives (or merge).
3. For a contradiction, prefer the information that is newer in EVENT time, but merge so non-contradicted specifics survive (e.g. an old pet list and a new pet list become one complete, dated list rather than the old one being deleted).
4. **Event time comes from the dates written in the content and the validity fields — never from created_at or which memory was stored last.** During history imports, storage order is arbitrary.
5. merged_content must be self-contained, factual, and keep absolute dates exactly as written in the sources. Do not editorialize or drop qualifiers.
6. If the two memories are about different people, they are distinct.

## Input

MEMORY A:
{memory_a}

MEMORY B:
{memory_b}

Return your adjudication.`;
