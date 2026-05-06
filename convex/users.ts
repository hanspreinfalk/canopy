import { internalMutation, mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";

async function getAuthedUser(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthorized");
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", identity.subject))
    .unique();
  if (!user) throw new Error("User not found");
  return user;
}

export const getSelfSummary = query({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthedUser(ctx);
    return {
      selfSummary: user.selfSummary ?? null,
      selfSummaryUpdatedAt: user.selfSummaryUpdatedAt ?? null,
    };
  },
});

export const updateSelfSummary = mutation({
  args: { text: v.string() },
  handler: async (ctx, args) => {
    const user = await getAuthedUser(ctx);
    await ctx.db.patch(user._id, {
      selfSummary: args.text,
      selfSummaryUpdatedAt: Date.now(),
    });
    return null;
  },
});

export const getCreditsBalance = query({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthedUser(ctx);
    return { creditsBalance: user.creditsBalance, plan: user.plan };
  },
});

export const getPreferredModel = query({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthedUser(ctx);
    return { preferredModel: user.preferredModel ?? null };
  },
});

export const updatePreferredModel = mutation({
  args: { model: v.string() },
  handler: async (ctx, args) => {
    const user = await getAuthedUser(ctx);
    await ctx.db.patch(user._id, { preferredModel: args.model });
    return null;
  },
});

export const upsertFromClerkWebhook = internalMutation({
  args: {
    clerkUserId: v.string(),
    email: v.string(),
    fullName: v.string(),
    profileImageUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerk_user_id", (q) =>
        q.eq("clerkUserId", args.clerkUserId),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        email: args.email,
        fullName: args.fullName,
        profileImageUrl: args.profileImageUrl,
      });
      return existing._id;
    }

    return await ctx.db.insert("users", {
      clerkUserId: args.clerkUserId,
      email: args.email,
      fullName: args.fullName,
      profileImageUrl: args.profileImageUrl,
      memoryEnabled: true,
      plan: "free",
      creditsBalance: 100,
      lastActiveAt: Date.now(),
    });
  },
});

export const deleteByClerkUserId = internalMutation({
  args: { clerkUserId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerk_user_id", (q) =>
        q.eq("clerkUserId", args.clerkUserId),
      )
      .first();

    if (existing) {
      await ctx.db.delete(existing._id);
    }
    return null;
  },
});
