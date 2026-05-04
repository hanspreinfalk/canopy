import { v } from "convex/values";
import { mutation, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";

const INACTIVITY_MS = 15 * 60 * 1000; // 15 min

async function getOrCreateConversation(
    ctx: MutationCtx,
    userId: Id<"users">,
    now: number
): Promise<Id<"conversations">> {
    const last = await ctx.db
        .query("conversations")
        .withIndex("by_user_id", (q) => q.eq("userId", userId))
        .order("desc")
        .first();

    if (last !== null && now - last.lastMessageAt < INACTIVITY_MS) {
        return last._id;
    }

    return await ctx.db.insert("conversations", {
        userId,
        lastMessageAt: now,
        messageCount: 0,
    });
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
        const conversationId = await getOrCreateConversation(ctx, user._id, now);

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

        return null;
    },
});
