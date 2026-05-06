"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const OPENAI_EMBEDDING_MODEL = "text-embedding-ada-002";
const ADA_EMBEDDING_DIMENSIONS = 1536;

function normalizeEmbedding(raw: unknown): number[] {
  if (!Array.isArray(raw)) {
    throw new Error("OpenAI embedding response was not an array.");
  }
  if (raw.length !== ADA_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Unexpected embedding length ${raw.length}; expected ${ADA_EMBEDDING_DIMENSIONS}.`,
    );
  }
  const out = raw.map((value) => Number(value));
  if (!out.every((value) => Number.isFinite(value))) {
    throw new Error("OpenAI embedding contains non-finite values.");
  }
  return out;
}

async function createEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY.");
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("Cannot embed empty text.");
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_EMBEDDING_MODEL,
      input: trimmed,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI embeddings request failed (${response.status}): ${body}`);
  }

  const payload = (await response.json()) as {
    data?: Array<{ embedding?: unknown }>;
  };
  const rawEmbedding = payload.data?.[0]?.embedding;
  return normalizeEmbedding(rawEmbedding);
}

function buildMessageEmbeddingInput(text: string, createdAtMs?: number): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return trimmed;
  if (createdAtMs === undefined) return trimmed;
  const iso = new Date(createdAtMs).toISOString();
  return `message_datetime_utc: ${iso}\nmessage_text: ${trimmed}`;
}

export const embedText = internalAction({
  args: { text: v.string() },
  handler: async (_ctx, args) => {
    return await createEmbedding(args.text);
  },
});

export const embedAndStoreMessageEmbedding = internalAction({
  args: {
    messageId: v.id("messages"),
    text: v.string(),
    createdAtMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const embeddingInput = buildMessageEmbeddingInput(args.text, args.createdAtMs);
    const embedding = await createEmbedding(embeddingInput);
    await ctx.runMutation(internal.messageEmbeddingsDb.setMessageEmbedding, {
      messageId: args.messageId,
      embedding,
    });
    return null;
  },
});
