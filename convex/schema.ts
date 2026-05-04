import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    clerkUserId: v.string(),
    email: v.string(),
    fullName: v.string(),
    profileImageUrl: v.optional(v.string()),
    credits: v.number(),
  })
    .index("by_email", ["email"])
    .index("by_clerk_user_id", ["clerkUserId"]),
});
