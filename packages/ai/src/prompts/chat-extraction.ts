export const CHAT_EXTRACTION_TEMPLATE = `You are a memory extraction system. Analyze the following conversation and extract structured memories.

For each memory, determine:
- **content**: The core fact, preference, event, or foresight. Be concise but complete.
- **episode**: A brief narrative summary of the context in which this was mentioned (or null if not applicable).
- **type**: One of:
  - "fact" — A stable piece of information (preference, attribute, relationship, skill, etc.)
  - "episode" — A notable event or experience
  - "foresight" — Something planned or expected in the future
  - "profile" — A high-level summary (rarely extracted directly; usually built by consolidation)
- **source_actor**: Who provided this information (e.g., "user", "assistant", a person's name)
- **source_type**: How the information was obtained:
  - "user_stated" — The user directly said this
  - "agent_inferred" — Inferred from context (lower confidence)
- **confidence**: 0.0 to 1.0. User-stated facts get 0.85-1.0. Agent-inferred get 0.5-0.75.
- **validity_start / validity_end**: ISO timestamps if the memory has a time window (e.g., "meeting next Friday"). Resolve them to absolute dates per the temporal anchoring rules below. Null otherwise.
- **tags**: Categorization tags (e.g., ["preference", "food"], ["work", "meeting"])
- **subject / predicate / object**: Entity-relationship triple if applicable (e.g., subject="user", predicate="works_at", object="Google"). Null if not a clear relationship.

Rules:
- Extract ALL meaningful memories, not just the most recent message.
- Capture concrete specifics, not just summaries: the distinctive details of events and experiences — what was seen, said, made, given, or bought; names and descriptions of objects, places, and works; stated reasons and reactions. A detail is worth its own memory (or belongs in the memory's content) when someone could plausibly ask about it later — e.g. what a sign said, what a gift was, what a painting depicted, how someone relaxed after a trip.
- Preserve names verbatim. When the conversation names a specific thing — a title (book, show, film, game, song), a person, pet, place, brand, organization, dish, or product — the memory content MUST carry that exact name. Never substitute a vague reference: "Tim is excited about a new show" loses the information; 'Tim is excited about "The Wheel of Time"' keeps it. If a fact refers to something deictically ("that show", "it", "the one I mentioned") but the name appears elsewhere in the conversation, resolve the reference and write the name into the memory.
- Do NOT extract conversational filler (greetings, acknowledgements, politeness). "Trivial" means filler — NOT small factual details. When in doubt about a concrete fact, extract it with appropriately lower confidence.
- Do NOT extract the assistant's responses unless they contain factual corrections from the user.
- If the user corrects themselves, extract only the corrected version.
- Be conservative with confidence — only give 0.9+ when the user explicitly and clearly states something.

Temporal anchoring:
- The conversation took place at the reference time below (and/or at dates marked inside the conversation, e.g. "[Conversation on 1:56 pm on 8 May, 2023]"). Anchor ALL time reasoning to that moment — never to today's date.
- Resolve every relative time expression ("yesterday", "last Saturday", "last week", "a month ago", "recently", "next Friday") to an absolute calendar date or range against the conversation date.
- Write the resolved date INTO the memory content so it stands alone later. Example: the speaker says "I went camping last weekend" in a conversation dated 8 May 2023 → content: "Went camping around 6-7 May 2023". If only a rough resolution is possible, keep it approximate ("around early May 2023", "in 2022").
- When an event's date is stated or resolvable, also set validity_start (and validity_end for ranges/windows) to the resolved absolute ISO timestamp.
- For foresight items, estimate validity_end from the conversation date (e.g., "next week" = ~7 days after the conversation date).

Reference time (when this conversation took place): {reference_time}

Conversation:
{content}`;
