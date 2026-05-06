"use node";

import { google } from "@ai-sdk/google";
import { generateText } from "ai";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

export const generateTitleForConversation = internalAction({
  args: {
    conversationId: v.id("conversations"),
    seedText: v.string(),
  },
  handler: async (ctx, args) => {
    const seed = args.seedText.trim().slice(0, 2000);
    let title = "New chat";
    try {
      const { text } = await generateText({
        model: google("gemini-2.5-flash"),
        prompt: `You name a chat thread. Given the first user message below, reply with ONLY a short title (maximum 8 words, no quotes, no trailing punctuation). If the message is empty or unusable, reply with exactly: New chat

First message:
${seed || "(empty)"}`,
      });
      const line = text.trim().split("\n")[0]?.trim() ?? "";
      if (line.length > 0) {
        title = line.slice(0, 120);
      }
    } catch (err) {
      console.error("conversation title generation failed", err);
    }

    await ctx.runMutation(internal.conversations.applyGeneratedTitle, {
      conversationId: args.conversationId,
      title,
    });
  },
});
