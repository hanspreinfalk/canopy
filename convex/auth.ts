import { QueryCtx } from "./_generated/server";

export const getCurrentUser = async (ctx: QueryCtx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      throw new Error("Unauthorized");
    }
  
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_user_id", (q) =>
        q.eq("clerkUserId", identity.tokenIdentifier)
      )
      .unique();
  
    if (!user) {
      throw new Error("User not found");
    }
  
    return user;
};