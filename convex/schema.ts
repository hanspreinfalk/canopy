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

        // Rolling summary
        summary: v.optional(v.string()),
        summaryUpdatedAt: v.optional(v.number()),
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
        status: v.union(
            v.literal("pending"),
            v.literal("running"),
            v.literal("done"),
            v.literal("failed")
        ),

        // Time window of messages this job processed
        processedFromTime: v.number(),
        processedToTime: v.number(),

        messagesProcessed: v.number(),
        memoriesCreated: v.number(),
        memoriesSuperseded: v.number(),

        error: v.optional(v.string()),
        completedAt: v.optional(v.number())
    })
    .index("by_user_id", ["userId"])
});
