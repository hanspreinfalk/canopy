import { v } from "convex/values";
import {
  mutation,
  query,
  internalMutation,
  MutationCtx,
  QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

async function getUserMutation(ctx: MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthorized");
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", identity.subject))
    .unique();
  if (!user) throw new Error("User not found");
  return user;
}

const INACTIVITY_MS = 15 * 60 * 1000; // 15 min

async function getOrCreateConversation(
    ctx: MutationCtx,
    userId: Id<"users">,
    now: number
): Promise<{ conversationId: Id<"conversations">; isNew: boolean }> {
    const last = await ctx.db
        .query("conversations")
        .withIndex("by_user_id", (q) => q.eq("userId", userId))
        .order("desc")
        .first();

    if (last !== null && now - last.lastMessageAt < INACTIVITY_MS) {
        return { conversationId: last._id, isNew: false };
    }

    const conversationId = await ctx.db.insert("conversations", {
        userId,
        lastMessageAt: now,
        messageCount: 0,
    });
    return { conversationId, isNew: true };
}

export const saveMessage = mutation({
    args: {
        role: v.union(v.literal("user"), v.literal("assistant")),
        content: v.string(),
    },
    handler: async (ctx, args) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) throw new Error("Unauthorized");

        // identity.subject is the Clerk user ID (e.g. "user_2xxx"), which is what
        // upsertFromClerkWebhook stores in clerkUserId via user.id from the webhook.
        // identity.tokenIdentifier is "{issuer}|{subject}" — different format.
        const user = await ctx.db
            .query("users")
            .withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", identity.subject))
            .unique();
        if (!user) throw new Error("User not found");

        const now = Date.now();
        const { conversationId, isNew } = await getOrCreateConversation(
            ctx,
            user._id,
            now
        );

        const messageId = await ctx.db.insert("messages", {
            userId: user._id,
            conversationId,
            role: args.role,
            parts: [{ type: "text", text: args.content }],
        });

        const conv = await ctx.db.get(conversationId);
        if (conv) {
            await ctx.db.patch(conversationId, {
                lastMessageAt: now,
                messageCount: conv.messageCount + 1,
            });
        }

        if (isNew && args.role === "user") {
            await ctx.scheduler.runAfter(
                0,
                internal.conversationTitleGeneration.generateTitleForConversation,
                { conversationId, seedText: args.content }
            );
        }

        return null;
    },
});

export const applyGeneratedTitle = internalMutation({
    args: {
        conversationId: v.id("conversations"),
        title: v.string(),
    },
    handler: async (ctx, args) => {
        const conversation = await ctx.db.get(args.conversationId);
        if (!conversation) return;
        const existing = conversation.title?.trim() ?? "";
        if (existing.length > 0) return;
        const next = args.title.trim();
        await ctx.db.patch(args.conversationId, {
            title: next.length > 0 ? next : "New chat",
        });
    },
});

// ─── Shared auth helper (inline, queries only) ────────────────────────────────

async function getUser(ctx: QueryCtx) {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");
    const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", identity.subject))
        .unique();
    if (!user) throw new Error("User not found");
    return user;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export const listConversations = query({
    args: { numItems: v.number() },
    handler: async (ctx, args) => {
        const user = await getUser(ctx);
        const limit = Math.min(Math.max(1, args.numItems), 100);
        const rows = await ctx.db
            .query("conversations")
            .withIndex("by_user_id", (q) => q.eq("userId", user._id))
            .order("desc")
            .take(limit + 1);
        return {
            conversations: rows.slice(0, limit),
            hasMore: rows.length > limit,
        };
    },
});

export const getRecentMessages = query({
    args: { limit: v.optional(v.number()) },
    handler: async (ctx, args) => {
        const user = await getUser(ctx);
        const limit = Math.min(args.limit ?? 10, 20);

        const conversation = await ctx.db
            .query("conversations")
            .withIndex("by_user_id", (q) => q.eq("userId", user._id))
            .order("desc")
            .first();

        if (!conversation || Date.now() - conversation.lastMessageAt >= INACTIVITY_MS) {
            return { messages: [] as Array<{ role: string; content: string }> };
        }

        const rows = await ctx.db
            .query("messages")
            .withIndex("by_conversation_id", (q) =>
                q.eq("conversationId", conversation._id)
            )
            .order("desc")
            .take(limit);

        return {
            messages: rows.reverse().map((m) => ({
                role: m.role,
                content:
                    m.parts
                        ?.filter((p: { type: string }) => p.type === "text")
                        .map((p: { text?: string }) => p.text ?? "")
                        .join("") ?? "",
            })),
        };
    },
});

export const renameConversation = mutation({
  args: {
    conversationId: v.id("conversations"),
    title: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getUserMutation(ctx);
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.userId !== user._id) {
      throw new Error("Not found");
    }
    const trimmed = args.title.trim();
    await ctx.db.patch(args.conversationId, {
      title: trimmed.length > 0 ? trimmed : undefined,
    });
    return null;
  },
});

export const deleteConversation = mutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const user = await getUserMutation(ctx);
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.userId !== user._id) {
      throw new Error("Not found");
    }
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .collect();
    for (const m of messages) {
      await ctx.db.delete(m._id);
    }
    await ctx.db.delete(args.conversationId);
    return null;
  },
});

export const listMessages = query({
    args: {
        conversationId: v.id("conversations"),
        numItems: v.number(),
    },
    handler: async (ctx, args) => {
        const user = await getUser(ctx);
        const conversation = await ctx.db.get(args.conversationId);
        if (!conversation || conversation.userId !== user._id) throw new Error("Not found");
        const limit = Math.min(Math.max(1, args.numItems), 200);
        const rows = await ctx.db
            .query("messages")
            .withIndex("by_conversation_id", (q) => q.eq("conversationId", args.conversationId))
            .order("asc")
            .take(limit + 1);
        return {
            messages: rows.slice(0, limit),
            hasMore: rows.length > limit,
        };
    },
});
