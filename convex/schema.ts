import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
    // ─────────────────────────────────────────────────────────────
    // USERS
    // ─────────────────────────────────────────────────────────────
    users: defineTable({
        // Identity
        email: v.string(),
        fullName: v.string(),
        profileImageUrl: v.optional(v.string()),
        clerkUserId: v.string(),
        timezone: v.optional(v.string()),
        locale: v.optional(v.string()),

        // Plan / billing
        plan: v.union(
            v.literal("free"),
            v.literal("pro")
        ),
        stripeCustomerId: v.optional(v.string()),

        // Credits 
        creditsBalance: v.number(),
        creditsGrantedThisPeriod: v.optional(v.number()),

        // Self summary
        selfSummary: v.optional(v.string()),
        selfSummaryUpdatedAt: v.optional(v.number()),

        // Assistant config
        memoryEnabled: v.boolean(),
        preferredModel: v.optional(v.string()),

        // Last active
        lastActiveAt: v.number()
    })
        .index("by_email", ["email"])
        .index("by_clerk_user_id", ["clerkUserId"])
        .index("by_last_active", ["lastActiveAt"])
    ,
    // ─────────────────────────────────────────────────────────────
    // CONVERSATIONS
    // ─────────────────────────────────────────────────────────────
    conversations: defineTable({
        userId: v.id("users"),
        title: v.optional(v.string()),
        lastMessageAt: v.number(),
        messageCount: v.number(),

        // Distillation tracking. pendingDistillationJobId is the in-flight
        // scheduled function distillation will run; saveMessage cancels +
        // reschedules it on every new user message. lastDistilledThroughTime
        // is the water mark of the latest message _creationTime included in
        // a completed distillation, used to keep reruns idempotent. The
        // current/historical summaries themselves live in the
        // `conversationSummaries` table, not on this row.
        pendingDistillationJobId: v.optional(v.id("_scheduled_functions")),
        lastDistilledThroughTime: v.optional(v.number()),
    })
    .index("by_user_id", ["userId"])
    ,
    // ─────────────────────────────────────────────────────────────
    // MESSAGES
    // ─────────────────────────────────────────────────────────────
    messages: defineTable({
        userId: v.id("users"),
        conversationId: v.id("conversations"),
        role: v.union(
            v.literal("user"),
            v.literal("assistant")
        ),
        parts: v.optional(v.any()),

        // Token + cost accounting (cost = estimated USD from model + token counts)
        tokensIn: v.optional(v.number()),
        tokensOut: v.optional(v.number()),
        cost: v.optional(v.number()),
        model: v.optional(v.string()),

        // Embedding
        embedding: v.optional(v.array(v.float64()))
    })
    .index("by_user_id", ["userId"])
    .index("by_conversation_id", ["conversationId"])
    .vectorIndex("by_embedding", {
        vectorField: "embedding",
        dimensions: 1536,
        filterFields: ["userId"],
      })
    ,
    // ─────────────────────────────────────────────────────────────
    // MEMORIES
    // ─────────────────────────────────────────────────────────────
    memories: defineTable({
        userId: v.id("users"),
        kind: v.union(
            v.literal("fact"),
            v.literal("preference"),
            v.literal("project"),
            v.literal("event"),
            v.literal("relationship"),
            v.literal("goal"),
            v.literal("skill")
        ),
        content: v.string(),

        // Where did this come from?
        origin: v.union(
            v.literal("auto"), // distilled from messages
            v.literal("user") // user said "remember that"
        ),

        // Embedding
        embedding: v.optional(v.array(v.float64())),

        // Source messages
        sourceMessageIds: v.array(v.id("messages")),

        // Ranking
        confidence: v.number(), // 0-1
        importance: v.number(), // 0-1

        // Memories can be superseded (e.g. "moved to NYC" replaces "lives in SF")
        supersededBy: v.optional(v.id("memories")),

        // Last updated
        updatedAt: v.number()
    })
    .index("by_user_id", ["userId"])
    .index("by_user_importance", ["userId", "importance"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["userId", "kind", "supersededBy"],
    })
    ,
    // ─────────────────────────────────────────────────────────────
    // CREDIT TRANSACTIONS
    // ─────────────────────────────────────────────────────────────
    creditTransactions: defineTable({
        userId: v.id("users"),
        amount: v.number(), // positive = grant, negative = spend 
        balanceAfter: v.number(),

        reason: v.union(
            v.literal("plan_grant"),
            v.literal("purchase"),
            v.literal("promo"),
            v.literal("refund"),
            v.literal("adjustment"),
            v.literal("spend")
        ),

        relatedMessageId: v.optional(v.id("messages")),
        stripeChargeId: v.optional(v.string()),
        note: v.optional(v.string())
    })
    .index("by_user_id", ["userId"])
    ,
    distillationJobs: defineTable({
        userId: v.id("users"),
        // Optional for legacy rows; new rows always include the conversation
        // they distilled.
        conversationId: v.optional(v.id("conversations")),
        status: v.union(
            v.literal("pending"),
            v.literal("running"),
            v.literal("done"),
            v.literal("failed"),
            v.literal("skipped")
        ),

        // Time window of messages this job processed
        processedFromTime: v.number(),
        processedToTime: v.number(),

        messagesProcessed: v.number(),
        memoriesCreated: v.number(),
        memoriesSuperseded: v.number(),
        summaryUpdated: v.optional(v.boolean()),

        error: v.optional(v.string()),
        skipReason: v.optional(v.string()),
        completedAt: v.optional(v.number())
    })
    .index("by_user_id", ["userId"])
    .index("by_conversation_id", ["conversationId"])
    ,
    // ─────────────────────────────────────────────────────────────
    // CONVERSATION SUMMARIES (history of distilled summaries)
    // ─────────────────────────────────────────────────────────────
    // A new row is appended every time distillation produces a fresh
    // summary for a conversation. The most recent row per conversation is
    // the "current" summary; older rows are kept for history. Use the
    // built-in `_creationTime` for ordering. The vector index lets the AI
    // retrieve the most relevant summary across all of the user's past
    // conversations.
    conversationSummaries: defineTable({
        userId: v.id("users"),
        conversationId: v.id("conversations"),
        summary: v.string(),
        embedding: v.optional(v.array(v.float64())),

        // Water mark for the latest message _creationTime included in this
        // summary. Used by distillation to confirm idempotent reruns.
        messagesProcessedThroughTime: v.number(),
    })
    .index("by_user_id", ["userId"])
    .index("by_conversation_id", ["conversationId"])
    .vectorIndex("by_embedding", {
        vectorField: "embedding",
        dimensions: 1536,
        filterFields: ["userId", "conversationId"],
    })
});
