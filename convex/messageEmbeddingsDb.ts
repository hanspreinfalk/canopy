import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

export const setMessageEmbedding = internalMutation({
  args: {
    messageId: v.id("messages"),
    embedding: v.array(v.number()),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) return;
    await ctx.db.patch(args.messageId, { embedding: args.embedding });
  },
});
