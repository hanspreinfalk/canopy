import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return -1;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  if (aNorm === 0 || bNorm === 0) return -1;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

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

export const searchMessagesByEmbedding = internalQuery({
  args: {
    clerkUserId: v.string(),
    queryEmbedding: v.array(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", args.clerkUserId))
      .unique();
    if (!user) return [];

    const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 8)), 20);
    const candidates = await ctx.db
      .query("messages")
      .withIndex("by_user_id", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(400);

    const scored = candidates
      .map((message) => {
        if (!message.embedding || message.embedding.length !== args.queryEmbedding.length) {
          return null;
        }
        const content = extractTextFromParts(message.parts);
        if (!content) return null;
        return {
          messageId: message._id,
          conversationId: message.conversationId,
          role: message.role,
          content,
          score: cosineSimilarity(args.queryEmbedding, message.embedding),
          createdAt: message._creationTime,
        };
      })
      .filter((item) => item !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored;
  },
});
