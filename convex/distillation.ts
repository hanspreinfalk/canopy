import { v } from "convex/values";
import {
  ActionCtx,
  internalMutation,
  internalQuery,
  MutationCtx,
  QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";

// 15 minutes of inactivity before distillation actually runs. Kept here
// (and used in conversations.ts) so both sides of the schedule use the
// same window.
export const DISTILLATION_INACTIVITY_MS = 15 * 60 * 1000;

// Hard cap on messages collected per distillation pass. Distillation runs
// after only 15 min of idle, so this is plenty in practice.
const DISTILLATION_MESSAGE_LIMIT = 500;

// ─── Helpers (private) ────────────────────────────────────────────────────────

function extractTextFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const p = part as { type?: unknown; text?: unknown };
      if (p.type !== "text" || typeof p.text !== "string") return "";
      return p.text;
    })
    .join("")
    .trim();
}

// ─── Distillation context (read by the action) ───────────────────────────────

// The action calls this internalQuery to gather everything it needs in a
// single transactional read. The two real guards are:
//   - the cancel-on-reschedule mechanism (saveMessage cancels prior schedules)
//   - the `lastDistilledThroughTime` water mark (prevents double-write)
// If a stale schedule slips through cancellation it will simply find no
// new messages and exit cleanly.
export const getDistillationContext = internalQuery({
  args: {
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) {
      return { skip: true as const, reason: "conversation_missing" };
    }

    const since = conversation.lastDistilledThroughTime ?? 0;

    const messagesAsc = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversationId", args.conversationId).gt("_creationTime", since),
      )
      .order("asc")
      .take(DISTILLATION_MESSAGE_LIMIT);

    const messages = messagesAsc
      .map((m) => ({
        id: m._id,
        role: m.role,
        text: extractTextFromParts(m.parts),
        _creationTime: m._creationTime,
      }))
      .filter((m) => m.text.length > 0);

    if (messages.length === 0) {
      return { skip: true as const, reason: "no_new_messages" };
    }

    // Pull the previous summary (if any) for this conversation so the
    // model can refine it instead of starting from scratch. We sort by
    // _creationTime desc, take 1.
    const previousSummaryRow = await ctx.db
      .query("conversationSummaries")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("desc")
      .first();

    // Existing memories for the user — the action will pass these to the
    // model so it can dedupe / supersede instead of producing duplicates.
    // We sample the top-importance, not-superseded ones.
    const candidateMemories = await ctx.db
      .query("memories")
      .withIndex("by_user_importance", (q) => q.eq("userId", conversation.userId))
      .order("desc")
      .take(80);

    const existingMemories = candidateMemories
      .filter((m) => m.supersededBy === undefined)
      .slice(0, 50)
      .map((m) => ({
        id: m._id,
        kind: m.kind,
        content: m.content,
        importance: m.importance,
      }));

    return {
      skip: false as const,
      userId: conversation.userId,
      conversationId: conversation._id,
      conversationTitle: conversation.title ?? null,
      // Per the schema spec: distillationJobs.processedFromTime is the
      // conversation's creation time, processedToTime is the timestamp of
      // the last message included in this pass.
      conversationCreationTime: conversation._creationTime,
      lastMessageCreationTime: messages[messages.length - 1]._creationTime,
      existingSummary: previousSummaryRow?.summary ?? null,
      existingMemories,
      messages,
    };
  },
});

// ─── Mutations the action calls back into ────────────────────────────────────

const memoryKindValidator = v.union(
  v.literal("fact"),
  v.literal("preference"),
  v.literal("project"),
  v.literal("event"),
  v.literal("relationship"),
  v.literal("goal"),
  v.literal("skill"),
);

export const persistDistillationResults = internalMutation({
  args: {
    userId: v.id("users"),
    conversationId: v.id("conversations"),
    // processedFromTime = conversation._creationTime (set by the action)
    // processedToTime   = the latest message _creationTime in this batch
    processedFromTime: v.number(),
    processedToTime: v.number(),
    messagesProcessed: v.number(),
    summary: v.optional(v.string()),
    summaryEmbedding: v.optional(v.array(v.number())),
    newMemories: v.array(
      v.object({
        kind: memoryKindValidator,
        content: v.string(),
        embedding: v.optional(v.array(v.number())),
        confidence: v.number(),
        importance: v.number(),
        sourceMessageIds: v.array(v.id("messages")),
        supersedesMemoryId: v.optional(v.id("memories")),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.userId !== args.userId) {
      throw new Error("Distillation target conversation missing or not owned");
    }

    // Idempotency: if the water mark already covers what we processed,
    // skip writing duplicates. This is the single source of truth — any
    // double schedule that races us will land here and exit cleanly.
    const alreadyDistilledThrough = conversation.lastDistilledThroughTime ?? 0;
    if (alreadyDistilledThrough >= args.processedToTime) {
      return {
        skipped: true as const,
        reason: "already_distilled",
        memoriesCreated: 0,
        memoriesSuperseded: 0,
        summaryUpdated: false,
      };
    }

    const now = Date.now();
    let memoriesCreated = 0;
    let memoriesSuperseded = 0;

    for (const mem of args.newMemories) {
      const trimmed = mem.content.trim();
      if (trimmed.length === 0) continue;

      const newId: Id<"memories"> = await ctx.db.insert("memories", {
        userId: args.userId,
        kind: mem.kind,
        content: trimmed,
        origin: "auto",
        sourceMessageIds: mem.sourceMessageIds,
        confidence: mem.confidence,
        importance: mem.importance,
        updatedAt: now,
        ...(mem.embedding !== undefined ? { embedding: mem.embedding } : {}),
      });
      memoriesCreated += 1;

      if (mem.supersedesMemoryId !== undefined) {
        const target = await ctx.db.get(mem.supersedesMemoryId);
        if (target && target.userId === args.userId && target.supersededBy === undefined) {
          await ctx.db.patch(mem.supersedesMemoryId, {
            supersededBy: newId,
            updatedAt: now,
          });
          memoriesSuperseded += 1;
        }
      }
    }

    let summaryUpdated = false;
    if (args.summary !== undefined && args.summary.trim().length > 0) {
      const summaryTrimmed = args.summary.trim();
      await ctx.db.insert("conversationSummaries", {
        userId: args.userId,
        conversationId: args.conversationId,
        summary: summaryTrimmed,
        messagesProcessedThroughTime: args.processedToTime,
        ...(args.summaryEmbedding !== undefined
          ? { embedding: args.summaryEmbedding }
          : {}),
      });
      summaryUpdated = true;
    }

    // Advance the water mark and clear the pending scheduler ID. Safe to
    // clear here because we just succeeded.
    await ctx.db.patch(args.conversationId, {
      lastDistilledThroughTime: args.processedToTime,
      pendingDistillationJobId: undefined,
    });

    await ctx.db.insert("distillationJobs", {
      userId: args.userId,
      conversationId: args.conversationId,
      status: "done",
      processedFromTime: args.processedFromTime,
      processedToTime: args.processedToTime,
      messagesProcessed: args.messagesProcessed,
      memoriesCreated,
      memoriesSuperseded,
      summaryUpdated,
      completedAt: now,
    });

    return {
      skipped: false as const,
      memoriesCreated,
      memoriesSuperseded,
      summaryUpdated,
    };
  },
});

export const recordDistillationFailure = internalMutation({
  args: {
    userId: v.id("users"),
    conversationId: v.id("conversations"),
    error: v.string(),
    processedFromTime: v.optional(v.number()),
    processedToTime: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("distillationJobs", {
      userId: args.userId,
      conversationId: args.conversationId,
      status: "failed",
      processedFromTime: args.processedFromTime ?? 0,
      processedToTime: args.processedToTime ?? 0,
      messagesProcessed: 0,
      memoriesCreated: 0,
      memoriesSuperseded: 0,
      error: args.error.slice(0, 1024),
      completedAt: Date.now(),
    });
    // Leave pendingDistillationJobId alone — a fresh user message may
    // already have replaced it with a new schedule.
  },
});

// ─── Scheduling helpers used by conversations.saveMessage ────────────────────

// Cancel the previous pending distillation (if any) and schedule a new
// one for `delayMs` from now. Returns the new scheduled function id so
// the caller can persist it on the conversation row.
export async function rescheduleConversationDistillation(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
  delayMs: number,
): Promise<Id<"_scheduled_functions">> {
  if (conversation.pendingDistillationJobId !== undefined) {
    try {
      await ctx.scheduler.cancel(conversation.pendingDistillationJobId);
    } catch {
      // The previous job may have already started or finished; either
      // way there's nothing to cancel and we can move on.
    }
  }

  return await ctx.scheduler.runAfter(
    delayMs,
    internal.distillationActions.runDistillation,
    {
      conversationId: conversation._id,
    },
  );
}

// ─── Retrieval (used by chat tools + system prompt) ──────────────────────────

async function resolveUserByClerkId(
  ctx: QueryCtx,
  clerkUserId: string,
): Promise<Doc<"users"> | null> {
  return await ctx.db
    .query("users")
    .withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", clerkUserId))
    .unique();
}

export const getRecentConversationSummariesForClerkUser = internalQuery({
  args: {
    clerkUserId: v.string(),
    limit: v.optional(v.number()),
    excludeConversationId: v.optional(v.id("conversations")),
  },
  handler: async (ctx, args) => {
    const user = await resolveUserByClerkId(ctx, args.clerkUserId);
    if (!user) return [];

    const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 3)), 10);

    // Pull a generous batch (rows ordered by built-in _creationTime desc)
    // and de-dupe to one summary per conversation so we don't return
    // multiple revisions of the same chat.
    const rows = await ctx.db
      .query("conversationSummaries")
      .withIndex("by_user_id", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(limit * 6);

    const seen = new Set<string>();
    const out: Array<{
      summary: string;
      conversationId: Id<"conversations">;
      _creationTime: number;
    }> = [];

    for (const row of rows) {
      if (
        args.excludeConversationId !== undefined &&
        row.conversationId === args.excludeConversationId
      ) {
        continue;
      }
      const key = String(row.conversationId);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        summary: row.summary,
        conversationId: row.conversationId,
        _creationTime: row._creationTime,
      });
      if (out.length >= limit) break;
    }
    return out;
  },
});

// ─── Action-context retrieval (uses Convex's vector index) ──────────────────
//
// vectorSearch is action-only, so these are plain async helpers that take
// the caller's ActionCtx (httpAction in chat.ts has the right ctx). Per
// Convex's "don't use action-from-action unless crossing runtimes" rule,
// we share the logic via a function instead of registering an action.

export const getUserIdByClerkId = internalQuery({
  args: { clerkUserId: v.string() },
  handler: async (ctx, args) => {
    const user = await resolveUserByClerkId(ctx, args.clerkUserId);
    return user?._id ?? null;
  },
});

export const getMemoriesByIds = internalQuery({
  args: {
    ids: v.array(v.id("memories")),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const docs = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return docs.filter(
      (d): d is NonNullable<typeof d> => d !== null && d.userId === args.userId,
    );
  },
});

export const getConversationSummariesByIds = internalQuery({
  args: {
    ids: v.array(v.id("conversationSummaries")),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const docs = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return docs.filter(
      (d): d is NonNullable<typeof d> => d !== null && d.userId === args.userId,
    );
  },
});

export type MemoryHit = {
  memoryId: Id<"memories">;
  kind: Doc<"memories">["kind"];
  content: string;
  confidence: number;
  importance: number;
  updatedAt: number;
  score: number;
};

export type ConversationSummaryHit = {
  conversationId: Id<"conversations">;
  summary: string;
  _creationTime: number;
  score: number;
};

// Hard ceiling on vectorSearch limit per Convex (1-256). Used to bound
// our overfetch.
const VECTOR_SEARCH_MAX = 256;

// `memories.by_embedding` is filterable by ["userId", "kind", "supersededBy"].
// We filter by userId only — the vector filter API only supports `eq` to
// a known value, and "supersededBy is unset" is awkward to express, so we
// overfetch and drop superseded rows in JS.
export async function searchMemoriesViaVectorIndex(
  ctx: ActionCtx,
  args: {
    clerkUserId: string;
    queryEmbedding: number[];
    limit?: number;
  },
): Promise<MemoryHit[]> {
  const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 6)), 20);

  const userId = await ctx.runQuery(internal.distillation.getUserIdByClerkId, {
    clerkUserId: args.clerkUserId,
  });
  if (!userId) return [];

  const overfetch = Math.min(limit * 3, VECTOR_SEARCH_MAX);
  const hits = await ctx.vectorSearch("memories", "by_embedding", {
    vector: args.queryEmbedding,
    limit: overfetch,
    filter: (q) => q.eq("userId", userId),
  });
  if (hits.length === 0) return [];

  const idToScore = new Map<string, number>();
  for (const h of hits) idToScore.set(String(h._id), h._score);

  const memories = await ctx.runQuery(internal.distillation.getMemoriesByIds, {
    ids: hits.map((h) => h._id),
    userId,
  });

  const out: MemoryHit[] = [];
  for (const m of memories) {
    if (m.supersededBy !== undefined) continue;
    out.push({
      memoryId: m._id,
      kind: m.kind,
      content: m.content,
      confidence: m.confidence,
      importance: m.importance,
      updatedAt: m.updatedAt,
      score: idToScore.get(String(m._id)) ?? 0,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

// `conversationSummaries.by_embedding` is filterable by ["userId", "conversationId"].
// We filter by userId only and dedupe per conversationId in JS, keeping
// the highest-scoring entry per conversation.
export async function searchConversationSummariesViaVectorIndex(
  ctx: ActionCtx,
  args: {
    clerkUserId: string;
    queryEmbedding: number[];
    limit?: number;
  },
): Promise<ConversationSummaryHit[]> {
  const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 5)), 10);

  const userId = await ctx.runQuery(internal.distillation.getUserIdByClerkId, {
    clerkUserId: args.clerkUserId,
  });
  if (!userId) return [];

  const overfetch = Math.min(limit * 3, VECTOR_SEARCH_MAX);
  const hits = await ctx.vectorSearch(
    "conversationSummaries",
    "by_embedding",
    {
      vector: args.queryEmbedding,
      limit: overfetch,
      filter: (q) => q.eq("userId", userId),
    },
  );
  if (hits.length === 0) return [];

  const idToScore = new Map<string, number>();
  for (const h of hits) idToScore.set(String(h._id), h._score);

  const summaries = await ctx.runQuery(
    internal.distillation.getConversationSummariesByIds,
    {
      ids: hits.map((h) => h._id),
      userId,
    },
  );

  const bestPerConv = new Map<string, ConversationSummaryHit>();
  for (const s of summaries) {
    const score = idToScore.get(String(s._id)) ?? 0;
    const key = String(s.conversationId);
    const existing = bestPerConv.get(key);
    if (!existing || score > existing.score) {
      bestPerConv.set(key, {
        conversationId: s.conversationId,
        summary: s.summary,
        _creationTime: s._creationTime,
        score,
      });
    }
  }

  return Array.from(bestPerConv.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
