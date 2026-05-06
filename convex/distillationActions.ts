"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { DISTILLATION_SYSTEM_PROMPT } from "./systemPrompts";

const OPENAI_EMBEDDING_MODEL = "text-embedding-ada-002";
const ADA_EMBEDDING_DIMENSIONS = 1536;

// Small + fast model — distillation is a structured extraction task, not
// deep reasoning. Hardcoded by design.
const OPENAI_DISTILLATION_MODEL = "gpt-4o-mini";

const MEMORY_KINDS = [
  "fact",
  "preference",
  "project",
  "event",
  "relationship",
  "goal",
  "skill",
] as const;
type MemoryKind = (typeof MEMORY_KINDS)[number];

function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === "string" && (MEMORY_KINDS as readonly string[]).includes(value);
}

function clamp01(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

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
  return normalizeEmbedding(payload.data?.[0]?.embedding);
}

function buildTemporalEmbeddingInput(args: {
  kind: "memory" | "summary";
  text: string;
  anchorTimeMs: number;
  sourceTimesMs?: number[];
}): string {
  const trimmed = args.text.trim();
  if (trimmed.length === 0) return trimmed;

  const lines: string[] = [
    `artifact_type: ${args.kind}`,
    `anchor_datetime_utc: ${new Date(args.anchorTimeMs).toISOString()}`,
  ];

  const validTimes = (args.sourceTimesMs ?? [])
    .filter((t) => Number.isFinite(t))
    .map((t) => Math.floor(t));

  if (validTimes.length > 0) {
    let min = validTimes[0];
    let max = validTimes[0];
    for (const t of validTimes) {
      if (t < min) min = t;
      if (t > max) max = t;
    }
    lines.push(`source_start_datetime_utc: ${new Date(min).toISOString()}`);
    lines.push(`source_end_datetime_utc: ${new Date(max).toISOString()}`);
  }

  lines.push(`${args.kind}_text: ${trimmed}`);
  return lines.join("\n");
}

type DistillationContextMessage = {
  id: Id<"messages">;
  role: "user" | "assistant";
  text: string;
  _creationTime: number;
};

type DistillationContextMemory = {
  id: Id<"memories">;
  kind: string;
  content: string;
  importance: number;
};

function buildExtractionUserPrompt(args: {
  conversationTitle: string | null;
  existingSummary: string | null;
  existingMemories: DistillationContextMemory[];
  messages: DistillationContextMessage[];
}): string {
  const lines: string[] = [];
  if (args.conversationTitle) {
    lines.push(`Conversation title: ${args.conversationTitle}`);
  }
  if (args.existingSummary) {
    lines.push(`Previous summary: ${args.existingSummary}`);
  }
  if (args.existingMemories.length > 0) {
    lines.push("");
    lines.push("Existing memories (use these ids in supersedesMemoryId):");
    for (const m of args.existingMemories) {
      lines.push(`- [${m.id}] (${m.kind}, importance=${m.importance.toFixed(2)}) ${m.content}`);
    }
  }
  lines.push("");
  lines.push("Messages (oldest first; index is the position you can cite in sourceMessageIndices):");
  args.messages.forEach((m, i) => {
    const iso = new Date(m._creationTime).toISOString();
    lines.push(`[${i}] (${m.role} @ ${iso}) ${m.text}`);
  });
  lines.push("");
  lines.push("Produce the JSON now.");
  return lines.join("\n");
}

// ─── OpenAI extraction ───────────────────────────────────────────────────────

type ExtractedMemory = {
  kind: MemoryKind;
  content: string;
  confidence: number;
  importance: number;
  supersedesMemoryId: Id<"memories"> | undefined;
  sourceMessageIds: Id<"messages">[];
};

type ExtractionResult = {
  memories: ExtractedMemory[];
  summary: string;
};

function parseExtractionResponse(
  raw: string,
  context: {
    messages: DistillationContextMessage[];
    existingMemoryIds: Set<string>;
  },
): ExtractionResult {
  const trimmed = raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`Distillation model returned non-JSON output: ${trimmed.slice(0, 240)}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Distillation output was not an object.");
  }

  const obj = parsed as { memories?: unknown; summary?: unknown };
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";

  const memories: ExtractedMemory[] = [];
  if (Array.isArray(obj.memories)) {
    for (const entry of obj.memories) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as {
        kind?: unknown;
        content?: unknown;
        confidence?: unknown;
        importance?: unknown;
        supersedesMemoryId?: unknown;
        sourceMessageIndices?: unknown;
      };

      if (!isMemoryKind(e.kind)) continue;
      const content = typeof e.content === "string" ? e.content.trim() : "";
      if (content.length === 0) continue;

      let supersedesMemoryId: Id<"memories"> | undefined;
      if (typeof e.supersedesMemoryId === "string" && e.supersedesMemoryId.length > 0) {
        if (context.existingMemoryIds.has(e.supersedesMemoryId)) {
          supersedesMemoryId = e.supersedesMemoryId as Id<"memories">;
        }
      }

      const sourceMessageIds: Id<"messages">[] = [];
      if (Array.isArray(e.sourceMessageIndices)) {
        for (const idxRaw of e.sourceMessageIndices) {
          const idx = typeof idxRaw === "number" ? Math.floor(idxRaw) : NaN;
          if (Number.isFinite(idx) && idx >= 0 && idx < context.messages.length) {
            sourceMessageIds.push(context.messages[idx].id);
          }
        }
      }

      memories.push({
        kind: e.kind,
        content,
        confidence: clamp01(e.confidence),
        importance: clamp01(e.importance),
        supersedesMemoryId,
        sourceMessageIds,
      });
    }
  }

  return { memories, summary };
}

async function extractDistillationViaOpenAI(args: {
  conversationTitle: string | null;
  existingSummary: string | null;
  existingMemories: DistillationContextMemory[];
  messages: DistillationContextMessage[];
}): Promise<ExtractionResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY.");
  }

  const userPrompt = buildExtractionUserPrompt(args);

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_DISTILLATION_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: DISTILLATION_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `OpenAI distillation request failed (${response.status}): ${body.slice(0, 400)}`,
    );
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const raw = payload.choices?.[0]?.message?.content;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("OpenAI distillation returned empty content.");
  }

  return parseExtractionResponse(raw, {
    messages: args.messages,
    existingMemoryIds: new Set(args.existingMemories.map((m) => String(m.id))),
  });
}

// ─── The scheduled action ────────────────────────────────────────────────────

export const runDistillation = internalAction({
  args: {
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const context = await ctx.runQuery(internal.distillation.getDistillationContext, {
      conversationId: args.conversationId,
    });

    if (context.skip) {
      // Silent no-op for "conversation_missing" / "no_new_messages". The
      // next user message will schedule a fresh distillation if needed.
      console.log(
        `[distillation] skip conv=${args.conversationId} reason=${context.reason}`,
      );
      return null;
    }

    // Per spec: distillationJobs.processedFromTime = conversation creation
    // time, processedToTime = the latest message _creationTime in this batch.
    const processedFromTime = context.conversationCreationTime;
    const processedToTime = context.lastMessageCreationTime;
    const summarySourceTimes = context.messages.map((m) => m._creationTime);
    const messageTimeById = new Map<string, number>(
      context.messages.map((m) => [String(m.id), m._creationTime]),
    );

    try {
      const extraction = await extractDistillationViaOpenAI({
        conversationTitle: context.conversationTitle,
        existingSummary: context.existingSummary,
        existingMemories: context.existingMemories,
        messages: context.messages,
      });

      // Embed the summary (if any) and each memory in parallel. We tolerate
      // individual embedding failures by dropping that item rather than
      // failing the whole job.
      const summaryEmbeddingPromise: Promise<number[] | undefined> =
        extraction.summary.length > 0
          ? createEmbedding(
              buildTemporalEmbeddingInput({
                kind: "summary",
                text: extraction.summary,
                anchorTimeMs: processedToTime,
                sourceTimesMs: summarySourceTimes,
              }),
            ).catch((err) => {
              console.error("[distillation] summary embedding failed:", err);
              return undefined;
            })
          : Promise.resolve(undefined);

      const memoryEmbeddings = await Promise.all(
        extraction.memories.map(async (m) => {
          const sourceTimes = m.sourceMessageIds
            .map((id) => messageTimeById.get(String(id)))
            .filter((t): t is number => t !== undefined);
          try {
            return await createEmbedding(
              buildTemporalEmbeddingInput({
                kind: "memory",
                text: m.content,
                anchorTimeMs: processedToTime,
                sourceTimesMs: sourceTimes,
              }),
            );
          } catch (err) {
            console.error("[distillation] memory embedding failed:", err);
            return undefined;
          }
        }),
      );

      const summaryEmbedding = await summaryEmbeddingPromise;

      const newMemories = extraction.memories.map((m, i) => {
        const embedding = memoryEmbeddings[i];
        return {
          kind: m.kind,
          content: m.content,
          confidence: m.confidence,
          importance: m.importance,
          sourceMessageIds: m.sourceMessageIds,
          ...(embedding !== undefined ? { embedding } : {}),
          ...(m.supersedesMemoryId !== undefined
            ? { supersedesMemoryId: m.supersedesMemoryId }
            : {}),
        };
      });

      const result = await ctx.runMutation(
        internal.distillation.persistDistillationResults,
        {
          userId: context.userId,
          conversationId: context.conversationId,
          processedFromTime,
          processedToTime,
          messagesProcessed: context.messages.length,
          ...(extraction.summary.length > 0 ? { summary: extraction.summary } : {}),
          ...(summaryEmbedding !== undefined ? { summaryEmbedding } : {}),
          newMemories,
        },
      );

      console.log(
        `[distillation] done conv=${context.conversationId} msgs=${context.messages.length}` +
          ` mem=${result.memoriesCreated} superseded=${result.memoriesSuperseded}` +
          ` summary=${result.summaryUpdated} skipped=${result.skipped}`,
      );
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[distillation] error:", message);
      await ctx.runMutation(internal.distillation.recordDistillationFailure, {
        userId: context.userId,
        conversationId: context.conversationId,
        error: message,
        processedFromTime,
        processedToTime,
      });
      return null;
    }
  },
});
