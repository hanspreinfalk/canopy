import { httpRouter } from "convex/server";
import { ActionCtx, httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  searchConversationSummariesViaVectorIndex,
  searchMemoriesViaVectorIndex,
} from "../distillation";
import {
  buildSystemPrompt,
  type PastConversationSummary,
} from "../systemPrompts";

type HttpRouter = ReturnType<typeof httpRouter>;

// ─── Shared SSE normalizer ────────────────────────────────────────────────────
//
// Reads raw SSE from a provider stream and re-emits:
//   data: {"text":"chunk"}\n\n  …  data: [DONE]\n\n
//
// Each provider supplies an `extractText` function that knows how to pull
// the text chunk out of its own event payload shape.

type HistoryMessage = { role: "user" | "assistant"; content: string };
type NormalizedChatRequest = {
  message: string;
  model?: string;
  history?: HistoryMessage[];
  /** IANA timezone from the client, e.g. "America/Los_Angeles". */
  userTimeZone?: string;
};
type MCPChatRequest = NormalizedChatRequest & { entityId?: string };

function normalizedUserTimeZone(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  if (!t || t.length > 128) return undefined;
  if (/[\x00-\x1f\x7f]/.test(t)) return undefined;
  return t;
}

function transformToNormalizedSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  extractText: (parsed: Record<string, unknown>) => string | null
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";

  return new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const jsonStr = line.slice(6).trim();
            if (jsonStr === "[DONE]") {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
              return;
            }
            try {
              const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
              const text = extractText(parsed);
              if (text) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ text })}\n\n`)
                );
              }
            } catch {
              // skip malformed SSE lines
            }
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

// ─── /chat/google ─────────────────────────────────────────────────────────────

const handleGoogleChat = httpAction(async (_ctx, request) => {
  const req = (await request.json()) as NormalizedChatRequest;
  const { message, model = "gemini-2.5-flash", history = [] } = req;
  const userTz = normalizedUserTimeZone(req.userTimeZone);

  const historyContents = history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: buildSystemPrompt({ userTimeZone: userTz }) }] },
    contents: [...historyContents, { role: "user", parts: [{ text: message }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
  });

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${process.env.GOOGLE_GENERATIVE_AI_API_KEY}`,
    { method: "POST", headers: { "content-type": "application/json" }, body }
  );

  if (!response.ok || !response.body) {
    const errorBody = await response.text();
    console.error(`[/chat/google] Gemini error ${response.status}: ${errorBody}`);
    return new Response(errorBody, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(
    transformToNormalizedSSE(response.body.getReader(), (p) => {
      const candidates = p["candidates"] as Array<Record<string, unknown>> | undefined;
      const content = candidates?.[0]?.["content"] as Record<string, unknown> | undefined;
      const parts = content?.["parts"] as Array<Record<string, unknown>> | undefined;
      return (parts?.[0]?.["text"] as string | undefined) ?? null;
    }),
    { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } }
  );
});

// ─── /chat/anthropic ──────────────────────────────────────────────────────────

const handleAnthropicChat = httpAction(async (_ctx, request) => {
  const req = (await request.json()) as NormalizedChatRequest;
  const { message, model = "claude-sonnet-4-6", history = [] } = req;
  const userTz = normalizedUserTimeZone(req.userTimeZone);

  const body = JSON.stringify({
    model,
    max_tokens: 1024,
    stream: true,
    system: buildSystemPrompt({ userTimeZone: userTz }),
    messages: [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: message },
    ],
  });

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body,
  });

  if (!response.ok || !response.body) {
    const errorBody = await response.text();
    console.error(`[/chat/anthropic] Anthropic error ${response.status}: ${errorBody}`);
    return new Response(errorBody, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(
    transformToNormalizedSSE(response.body.getReader(), (p) => {
      if (p["type"] !== "content_block_delta") return null;
      const delta = p["delta"] as Record<string, unknown> | undefined;
      if (delta?.["type"] !== "text_delta") return null;
      return (delta?.["text"] as string | undefined) ?? null;
    }),
    { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } }
  );
});

// ─── /chat/openai ─────────────────────────────────────────────────────────────

const handleOpenAIChat = httpAction(async (_ctx, request) => {
  const req = (await request.json()) as NormalizedChatRequest;
  const { message, model = "gpt-4o", history = [] } = req;
  const userTz = normalizedUserTimeZone(req.userTimeZone);

  const body = JSON.stringify({
    model,
    stream: true,
    messages: [
      { role: "system", content: buildSystemPrompt({ userTimeZone: userTz }) },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: message },
    ],
  });

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body,
  });

  if (!response.ok || !response.body) {
    const errorBody = await response.text();
    console.error(`[/chat/openai] OpenAI error ${response.status}: ${errorBody}`);
    return new Response(errorBody, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(
    transformToNormalizedSSE(response.body.getReader(), (p) => {
      const choices = p["choices"] as Array<Record<string, unknown>> | undefined;
      const delta = choices?.[0]?.["delta"] as Record<string, unknown> | undefined;
      return (delta?.["content"] as string | undefined) ?? null;
    }),
    { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } }
  );
});

// ─── Composio shared types & helpers ──────────────────────────────────────────

type ComposioTool = {
  slug: string;
  description?: string;
  input_parameters?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  input_schema?: Record<string, unknown>;
};

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

// ─── Built-in tools ───────────────────────────────────────────────────────────
//
// Tools we implement ourselves (not via Composio). The model sees them in the
// tool list alongside Composio tools; when it calls one we don't hit Composio,
// we just emit tool events and feed back a synthetic tool_result so the loop
// keeps progressing.

const TAKE_SCREENSHOT_NAME = "take_screenshot";
const SEARCH_CHAT_MEMORY_NAME = "search_chat_memory";
const SEARCH_MESSAGES_LEGACY_ALIAS = "search_messages";
const RECALL_USER_MEMORIES_NAME = "recall_user_memories";
const RECALL_CONVERSATION_SUMMARY_NAME = "recall_conversation_summary";

const TAKE_SCREENSHOT_DESCRIPTION =
  "Capture the user's current screen and visually point them to a specific UI element with a small flying blue arrow. " +
  "Use whenever the user asks how to do something on their computer (e.g. 'how do I turn on dark mode', 'open System Settings', 'where's the share button', 'find the bookmark menu'). " +
  "Pass a tight, specific 'description' of what to point at — be concrete about the element AND where to look (e.g. 'the Apple menu in the top-left of the menu bar', 'the Dark Mode toggle in System Settings → Appearance'). " +
  "Always tell the user in one short, natural sentence what you're about to do BEFORE calling this tool (e.g. 'lemme show you'). " +
  "Don't call this for things that aren't an on-screen UI element.";

const TAKE_SCREENSHOT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    description: {
      type: "string",
      description:
        "Short, specific description of the UI element to point at, including where it lives on screen.",
    },
  },
  required: ["description"],
} as const;

const SEARCH_CHAT_MEMORY_DESCRIPTION =
  "Internal RAG memory retrieval over the user's saved app chat messages (user + assistant turns). " +
  "This does NOT search Gmail, Calendar, Stripe, or any external account. " +
  "Use it for memory/continuity questions such as 'what did I say before', 'recall prior context', or finding earlier chat details. " +
  "Input `query` is a natural-language memory query and `limit` controls matches to return.";

const SEARCH_CHAT_MEMORY_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Natural-language search query describing what historical messages to retrieve.",
    },
    limit: {
      type: "number",
      description: "Optional number of matches to return (1-20).",
    },
  },
  required: ["query"],
} as const;

const RECALL_USER_MEMORIES_DESCRIPTION =
  "Semantic search over distilled long-term memories about the user (facts, preferences, " +
  "relationships, projects, goals, skills). Use whenever knowing something durable about " +
  "the user would help. Pass `query` as a natural-language description of what you want " +
  "to recall (e.g. 'where the user lives', 'their dietary preferences', 'their partner's name'). " +
  "Returns the most relevant memories with confidence and importance scores. Internal RAG only.";

const RECALL_USER_MEMORIES_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Natural-language description of the kind of memory you're trying to recall.",
    },
    limit: {
      type: "number",
      description: "Optional number of memories to return (1-20).",
    },
  },
  required: ["query"],
} as const;

const RECALL_CONVERSATION_SUMMARY_DESCRIPTION =
  "Semantic search over summaries of the user's past conversations with you. Each summary " +
  "covers a previous chat (decisions, preferences, unresolved items). Use when the user " +
  "references an earlier chat, or when broader background than search_chat_memory is " +
  "useful. Pass `query` describing what context you need; pass an empty string (or omit) " +
  "to retrieve the most recent summaries. Internal RAG only.";

const RECALL_CONVERSATION_SUMMARY_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Natural-language description of the conversation context you're trying to find. " +
        "Empty string or omitted = return the most recent summaries.",
    },
    limit: {
      type: "number",
      description: "Optional number of summaries to return (1-10).",
    },
  },
  required: [],
} as const;

// Synthetic tool result we return to the model after a take_screenshot call.
// The actual screenshot capture + element location happens on the client,
// out of band; the model doesn't need the result in its conversation context,
// it just needs an acknowledgement so it can continue talking.
const TAKE_SCREENSHOT_TOOL_RESULT = JSON.stringify({
  status: "ok",
  note: "Screenshot captured and the user is being shown the location with a visual arrow on their screen. Briefly tell them what to click or do next.",
});

function isBuiltInToolName(name: string): boolean {
  return (
    name === TAKE_SCREENSHOT_NAME ||
    name === SEARCH_CHAT_MEMORY_NAME ||
    name === SEARCH_MESSAGES_LEGACY_ALIAS ||
    name === RECALL_USER_MEMORIES_NAME ||
    name === RECALL_CONVERSATION_SUMMARY_NAME
  );
}

// We type these helpers against the full ActionCtx so that the typed
// FunctionReference call sites below stay strict.
type BuiltInToolCtx = Pick<ActionCtx, "runAction" | "runQuery">;

function clampLimit(raw: unknown, max: number): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.min(Math.max(1, Math.floor(raw)), max);
}

async function embedQueryText(ctx: BuiltInToolCtx, text: string): Promise<number[]> {
  const result = await ctx.runAction(internal.messageEmbeddings.embedText, { text });
  if (!Array.isArray(result)) {
    throw new Error("embedText did not return an array");
  }
  return result as number[];
}

async function executeSearchMessagesTool(
  ctx: BuiltInToolCtx,
  input: Record<string, unknown>,
  entityId: string,
): Promise<unknown> {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) return { error: "search_chat_memory requires a non-empty `query`." };
  if (!entityId || entityId === "default") {
    return { error: "search_chat_memory requires a real `entityId` for user scoping." };
  }
  const limit = clampLimit(input.limit, 20);

  const queryEmbedding = await embedQueryText(ctx, query);

  const resultsUnknown = await ctx.runQuery(
    internal.messageRag.searchMessagesByEmbedding,
    {
      clerkUserId: entityId,
      queryEmbedding,
      ...(limit !== undefined ? { limit } : {}),
    },
  );
  const results = Array.isArray(resultsUnknown) ? resultsUnknown : [];

  return {
    tool: SEARCH_CHAT_MEMORY_NAME,
    query,
    total: results.length,
    results,
  };
}

async function executeRecallUserMemoriesTool(
  ctx: ActionCtx,
  input: Record<string, unknown>,
  entityId: string,
): Promise<unknown> {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) return { error: "recall_user_memories requires a non-empty `query`." };
  if (!entityId || entityId === "default") {
    return { error: "recall_user_memories requires a real `entityId` for user scoping." };
  }
  const limit = clampLimit(input.limit, 20);

  const queryEmbedding = await embedQueryText(ctx, query);

  const results = await searchMemoriesViaVectorIndex(ctx, {
    clerkUserId: entityId,
    queryEmbedding,
    ...(limit !== undefined ? { limit } : {}),
  });

  return {
    tool: RECALL_USER_MEMORIES_NAME,
    query,
    total: results.length,
    // Strip raw scores/memory ids before sending to the model — it just
    // needs the content.
    results: results.map((r) => ({
      kind: r.kind,
      content: r.content,
      confidence: r.confidence,
      importance: r.importance,
      updatedAt: r.updatedAt,
    })),
  };
}

async function executeRecallConversationSummaryTool(
  ctx: ActionCtx,
  input: Record<string, unknown>,
  entityId: string,
): Promise<unknown> {
  if (!entityId || entityId === "default") {
    return {
      error: "recall_conversation_summary requires a real `entityId` for user scoping.",
    };
  }
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const limit = clampLimit(input.limit, 10);

  if (query.length === 0) {
    const recentUnknown = await ctx.runQuery(
      internal.distillation.getRecentConversationSummariesForClerkUser,
      {
        clerkUserId: entityId,
        ...(limit !== undefined ? { limit } : {}),
      },
    );
    const recent = Array.isArray(recentUnknown) ? recentUnknown : [];
    return {
      tool: RECALL_CONVERSATION_SUMMARY_NAME,
      mode: "recent",
      total: recent.length,
      results: (recent as Array<Record<string, unknown>>).map((r) => ({
        summary: r.summary,
        _creationTime: r._creationTime,
      })),
    };
  }

  const queryEmbedding = await embedQueryText(ctx, query);

  const results = await searchConversationSummariesViaVectorIndex(ctx, {
    clerkUserId: entityId,
    queryEmbedding,
    ...(limit !== undefined ? { limit } : {}),
  });

  return {
    tool: RECALL_CONVERSATION_SUMMARY_NAME,
    mode: "search",
    query,
    total: results.length,
    results: results.map((r) => ({
      summary: r.summary,
      _creationTime: r._creationTime,
    })),
  };
}

async function executeBuiltInTool(
  ctx: ActionCtx,
  name: string,
  input: Record<string, unknown>,
  entityId: string,
): Promise<unknown> {
  if (name === TAKE_SCREENSHOT_NAME) {
    return JSON.parse(TAKE_SCREENSHOT_TOOL_RESULT);
  }
  if (name === SEARCH_CHAT_MEMORY_NAME || name === SEARCH_MESSAGES_LEGACY_ALIAS) {
    return await executeSearchMessagesTool(ctx, input, entityId);
  }
  if (name === RECALL_USER_MEMORIES_NAME) {
    return await executeRecallUserMemoriesTool(ctx, input, entityId);
  }
  if (name === RECALL_CONVERSATION_SUMMARY_NAME) {
    return await executeRecallConversationSummaryTool(ctx, input, entityId);
  }
  return { error: `Unknown built-in tool: ${name}` };
}

// Helper to fetch the past N conversation summaries for a Clerk user id
// so the MCP routes can inject them into the system prompt. Failures are
// swallowed (returns []) — these are background context, not a blocker
// for chat. Since the call is a query, no embeddings or OpenAI calls.
async function fetchPastConversationSummariesForPrompt(
  ctx: BuiltInToolCtx,
  entityId: string | undefined,
  limit = 3,
): Promise<PastConversationSummary[]> {
  if (!entityId || entityId === "default") return [];
  try {
    const recentUnknown = await ctx.runQuery(
      internal.distillation.getRecentConversationSummariesForClerkUser,
      { clerkUserId: entityId, limit },
    );
    if (!Array.isArray(recentUnknown)) return [];
    return (recentUnknown as Array<Record<string, unknown>>)
      .map((r) => ({
        summary: typeof r.summary === "string" ? r.summary : "",
        _creationTime: typeof r._creationTime === "number" ? r._creationTime : 0,
      }))
      .filter((s) => s.summary.length > 0);
  } catch (err) {
    console.error("[chat] failed to load past conversation summaries:", err);
    return [];
  }
}

const COMPOSIO_BASE = "https://backend.composio.dev";

function composioHeaders() {
  return { "x-api-key": process.env.COMPOSIO_API_KEY!, "Content-Type": "application/json" };
}

// ─── Composio tool cache ──────────────────────────────────────────────────────
//
// Per-process in-memory cache of Composio tools, keyed by entityId.
// Avoids re-fetching connected_accounts + per-toolkit tools on every message.
//
// TTL is intentionally short-ish: long enough to cover a multi-message chat
// session, short enough that newly-connected toolkits show up reasonably soon.
// Call `invalidateComposioToolsCache(entityId)` from your "user connected a
// toolkit" handler to make changes immediate.

const COMPOSIO_TOOLS_TTL_MS = 5 * 60 * 1000; // 5 minutes
type CacheEntry = { tools: ComposioTool[]; expiresAt: number };
const composioToolsCache = new Map<string, CacheEntry>();
// Coalesce concurrent fetches for the same entityId so a burst of messages
// doesn't trigger N parallel cache-misses.
const composioToolsInflight = new Map<string, Promise<ComposioTool[]>>();

export function invalidateComposioToolsCache(entityId?: string) {
  if (entityId) {
    composioToolsCache.delete(entityId);
    composioToolsInflight.delete(entityId);
  } else {
    composioToolsCache.clear();
    composioToolsInflight.clear();
  }
}

async function fetchComposioToolsUncached(entityId: string): Promise<ComposioTool[]> {
  const connResp = await fetch(
    `${COMPOSIO_BASE}/api/v3/connected_accounts?user_ids=${encodeURIComponent(entityId)}&limit=100`,
    { headers: composioHeaders() }
  );
  const connectedSlugs: string[] = [];
  if (connResp.ok) {
    const connData = (await connResp.json()) as {
      items?: Array<{ toolkit?: { slug?: string }; status?: string }>;
    };
    for (const item of connData.items ?? []) {
      if (item.status === "ACTIVE" && item.toolkit?.slug) {
        connectedSlugs.push(item.toolkit.slug);
      }
    }
  }
  console.log(`[composio] connected toolkits for ${entityId}:`, connectedSlugs);
  if (connectedSlugs.length === 0) return [];

  const toolArrays = await Promise.all(
    connectedSlugs.map(async (slug) => {
      const resp = await fetch(
        `${COMPOSIO_BASE}/api/v3/tools?toolkit_slug=${encodeURIComponent(slug)}&limit=100`,
        { headers: composioHeaders() }
      );
      if (!resp.ok) return [] as ComposioTool[];
      const data = (await resp.json()) as { items?: ComposioTool[] };
      return data.items ?? [];
    })
  );
  return toolArrays.flat();
}

async function fetchComposioTools(entityId: string): Promise<ComposioTool[]> {
  const now = Date.now();
  const cached = composioToolsCache.get(entityId);
  if (cached && cached.expiresAt > now) {
    return cached.tools;
  }

  const inflight = composioToolsInflight.get(entityId);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const tools = await fetchComposioToolsUncached(entityId);
      composioToolsCache.set(entityId, { tools, expiresAt: Date.now() + COMPOSIO_TOOLS_TTL_MS });
      return tools;
    } finally {
      composioToolsInflight.delete(entityId);
    }
  })();
  composioToolsInflight.set(entityId, promise);
  return promise;
}

async function executeComposioTool(
  toolName: string,
  args: Record<string, unknown>,
  entityId: string
): Promise<unknown> {
  const resp = await fetch(`${COMPOSIO_BASE}/api/v3/tools/execute/${toolName}`, {
    method: "POST",
    headers: composioHeaders(),
    body: JSON.stringify({ arguments: args, user_id: entityId }),
  });
  return resp.ok ? resp.json() : { error: `HTTP ${resp.status}` };
}

/** Bound client-supplied history so prior turns (esp. huge tool JSON) cannot blow provider limits. */
const MAX_MCP_HISTORY_MESSAGES = 40;
const MAX_HISTORY_MESSAGE_CHARS = 16_000;

function trimHistoryForMCP(history: HistoryMessage[]): HistoryMessage[] {
  const sliced =
    history.length > MAX_MCP_HISTORY_MESSAGES
      ? history.slice(-MAX_MCP_HISTORY_MESSAGES)
      : history;
  return sliced.map((m) => {
    if (m.content.length <= MAX_HISTORY_MESSAGE_CHARS) return m;
    return {
      role: m.role,
      content:
        m.content.slice(0, MAX_HISTORY_MESSAGE_CHARS) +
        `\n\n...[truncated history message, ${m.content.length} chars total]`,
    };
  });
}

/** Keep tool_result / function responses under provider context limits. */
const MAX_TOOL_RESULT_JSON_CHARS = 28_000;
const MAX_GMAIL_LIST_ITEMS = 10;
const MAX_GMAIL_BODY_CHARS = 2_500;
const GENERIC_STRING_CAP = 4_000;

/**
 * Composio exposes ~94 tools with very large JSON Schemas.
 * Anthropic counts the full tool list JSON toward the 200k-token context limit.
 *
 * Strategy (three passes, stop at first that fits):
 *   Pass 1 – slim:  strip schema description/title/examples, cap desc to 500 chars.
 *   Pass 2 – shell: keep only property names+types (no nested metadata), cap desc to 300 chars.
 *   Pass 3 – bare:  empty schema `{type:"object",properties:{}}` for all, desc 200 chars.
 *
 * The budget is conservative; Anthropic allows 200k tokens and we need ~120k for
 * system + history + messages + tool results, leaving ~80k chars (~20k tokens) for tools.
 */
const MAX_TOOLS_TOTAL_JSON_CHARS = 320_000; // ~80k tokens; enforced per-pass

function capDesc(s: string, max: number): string {
  if (typeof s !== "string") return "";
  return s.length <= max ? s : s.slice(0, max) + "…";
}

function keepOnlyTypesAndRequired(node: unknown, depth: number): unknown {
  if (depth <= 0) return {};
  if (Array.isArray(node)) return node.map((x) => keepOnlyTypesAndRequired(x, depth - 1));
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    const allowed = new Set(["type", "required", "properties", "items", "enum", "anyOf", "oneOf", "allOf"]);
    for (const [k, v] of Object.entries(o)) {
      if (allowed.has(k)) next[k] = keepOnlyTypesAndRequired(v, depth - 1);
    }
    return next;
  }
  return node;
}

function stripSchemaMetadata(node: unknown, depth: number): unknown {
  if (depth <= 0) return node;
  if (Array.isArray(node)) return node.map((x) => stripSchemaMetadata(x, depth - 1));
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === "description" || k === "title" || k === "examples" || k === "default") continue;
      next[k] = stripSchemaMetadata(v, depth - 1);
    }
    return next;
  }
  return node;
}

const EMPTY_SCHEMA: Record<string, unknown> = { type: "object", properties: {} };

function buildComposioAnthropicTools(rawTools: ComposioTool[]): Array<Record<string, unknown>> {
  const buildPass = (
    descMax: number,
    schemaTx: (raw: Record<string, unknown>) => Record<string, unknown>,
  ): Array<Record<string, unknown>> =>
    rawTools.map((t) => {
      const raw = (t.input_parameters ?? t.input_schema ?? t.parameters ?? EMPTY_SCHEMA) as Record<string, unknown>;
      return {
        name: t.slug,
        description: capDesc(typeof t.description === "string" ? t.description : "", descMax),
        input_schema: schemaTx(raw),
      };
    });

  for (const [descMax, schemaTx] of [
    [500, (r: Record<string, unknown>) => stripSchemaMetadata(r, 30) as Record<string, unknown>],
    [300, (r: Record<string, unknown>) => keepOnlyTypesAndRequired(r, 20) as Record<string, unknown>],
    [200, (_r: Record<string, unknown>) => ({ ...EMPTY_SCHEMA })],
  ] as Array<[number, (r: Record<string, unknown>) => Record<string, unknown>]>) {
    const tools = buildPass(descMax, schemaTx);
    const totalChars = JSON.stringify(tools).length;
    console.log(`[composio-tools] pass descMax=${descMax} → ${tools.length} tools, ${totalChars} chars`);
    if (totalChars <= MAX_TOOLS_TOTAL_JSON_CHARS) return tools;
  }

  // Absolute last resort: names + trimmed descriptions only.
  return rawTools.map((t) => ({
    name: t.slug,
    description: capDesc(typeof t.description === "string" ? t.description : "", 120),
    input_schema: { ...EMPTY_SCHEMA },
  }));
}

function truncateGmailMessageRecord(msg: Record<string, unknown>): Record<string, unknown> {
  const out = { ...msg };
  const bodyKeys = ["messageText", "body", "html", "text", "snippet", "plainText", "messageBody"];
  for (const key of bodyKeys) {
    const v = out[key];
    if (typeof v === "string" && v.length > MAX_GMAIL_BODY_CHARS) {
      out[key] =
        v.slice(0, MAX_GMAIL_BODY_CHARS) +
        `\n…[truncated ${key}, ${v.length} chars total]`;
    }
  }
  return out;
}

function sanitizeGmailLikeToolPayload(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const root = data as Record<string, unknown>;
  const out: Record<string, unknown> = { ...root };

  const shrinkMessagesArray = (arr: unknown[], pathLabel: string) => {
    const slice = arr.slice(0, MAX_GMAIL_LIST_ITEMS).map((m) => {
      if (m && typeof m === "object") return truncateGmailMessageRecord(m as Record<string, unknown>);
      return m;
    });
    const omitted = arr.length - slice.length;
    if (omitted > 0) {
      return {
        messages: slice,
        _truncatedMessages: true,
        _omittedMessageCount: omitted,
        _path: pathLabel,
      };
    }
    return { messages: slice };
  };

  if (out.data && typeof out.data === "object") {
    const d = out.data as Record<string, unknown>;
    const dOut: Record<string, unknown> = { ...d };
    if (Array.isArray(d.messages)) {
      const shrunk = shrinkMessagesArray(d.messages, "data.messages");
      dOut.messages = shrunk.messages;
      if ("_truncatedMessages" in shrunk) {
        dOut._truncatedMessages = shrunk._truncatedMessages;
        dOut._omittedMessageCount = shrunk._omittedMessageCount;
        dOut._truncatedPath = shrunk._path;
      }
    }
    out.data = dOut;
  }

  if (Array.isArray(out.messages)) {
    const shrunk = shrinkMessagesArray(out.messages, "messages");
    out.messages = shrunk.messages;
    if ("_truncatedMessages" in shrunk) {
      out._truncatedMessages = shrunk._truncatedMessages;
      out._omittedMessageCount = shrunk._omittedMessageCount;
      out._truncatedPath = shrunk._path;
    }
  }

  return out;
}

function deepTruncateStrings(value: unknown, maxLen: number, depth: number): unknown {
  if (depth <= 0) return value;
  if (typeof value === "string") {
    if (value.length <= maxLen) return value;
    return value.slice(0, maxLen) + `\n…[truncated string, ${value.length} chars total]`;
  }
  if (Array.isArray(value)) {
    return value.map((x) => deepTruncateStrings(x, maxLen, depth - 1));
  }
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const k of Object.keys(o)) {
      next[k] = deepTruncateStrings(o[k], maxLen, depth - 1);
    }
    return next;
  }
  return value;
}

/**
 * Shrinks tool execution results before they are JSON-stringified into the next model prompt.
 * Composio integrations (e.g. Gmail fetch) can return hundreds of KB and exceed Anthropic's 200k cap.
 */
function sanitizeToolResultForModel(toolName: string, execData: unknown): unknown {
  if (execData && typeof execData === "object" && "error" in execData) {
    return execData;
  }

  const upper = toolName.toUpperCase();
  let shaped = execData;
  if (upper.startsWith("GMAIL_")) {
    shaped = sanitizeGmailLikeToolPayload(shaped);
  }

  shaped = deepTruncateStrings(shaped, GENERIC_STRING_CAP, 12);

  let serialized = JSON.stringify(shaped);
  if (serialized.length <= MAX_TOOL_RESULT_JSON_CHARS) return shaped;

  shaped = deepTruncateStrings(shaped, Math.floor(GENERIC_STRING_CAP / 2), 8);
  serialized = JSON.stringify(shaped);
  if (serialized.length <= MAX_TOOL_RESULT_JSON_CHARS) return shaped;

  return {
    _truncated: true,
    _reason: "tool_result_exceeded_size_limit",
    toolName,
    approxSerializedChars: serialized.length,
    preview: serialized.slice(0, 12_000),
  };
}

// ─── SSE event helpers ────────────────────────────────────────────────────────
//
// In addition to the existing `{text: "..."}` chunks, we now emit
// `{tool_start: {name, id}}` and `{tool_end: {id, ok}}` events so the
// frontend can render a "Calling gmail_send..." indicator while tools run.

function emitText(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  text: string
) {
  console.log(`[${Date.now()}] emitText: ${text.slice(0, 40).replace(/\n/g, "\\n")}`);
  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
}

function emitEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  event: Record<string, unknown>
) {
  console.log(`[${Date.now()}] emitEvent: ${JSON.stringify(event).slice(0, 80)}`);
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
}

/** Final SSE metadata for persisting token usage (client saves with assistant message). */
function emitUsageSummary(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  summary: { tokensIn: number; tokensOut: number; model: string }
) {
  emitEvent(controller, encoder, {
    usage: {
      tokensIn: summary.tokensIn,
      tokensOut: summary.tokensOut,
      model: summary.model,
    },
  });
}

// ─── /chat/google-mcp (Gemini + Composio tools) ───────────────────────────────

type GeminiContent = { role: string; parts: Array<Record<string, unknown>> };

function buildGeminiTools(rawTools: ComposioTool[]): unknown[] {
  const builtIn = [
    {
      name: TAKE_SCREENSHOT_NAME,
      description: TAKE_SCREENSHOT_DESCRIPTION,
      parameters: TAKE_SCREENSHOT_INPUT_SCHEMA as unknown as Record<string, unknown>,
    },
    {
      name: SEARCH_CHAT_MEMORY_NAME,
      description: SEARCH_CHAT_MEMORY_DESCRIPTION,
      parameters: SEARCH_CHAT_MEMORY_INPUT_SCHEMA as unknown as Record<string, unknown>,
    },
    {
      name: RECALL_USER_MEMORIES_NAME,
      description: RECALL_USER_MEMORIES_DESCRIPTION,
      parameters: RECALL_USER_MEMORIES_INPUT_SCHEMA as unknown as Record<string, unknown>,
    },
    {
      name: RECALL_CONVERSATION_SUMMARY_NAME,
      description: RECALL_CONVERSATION_SUMMARY_DESCRIPTION,
      parameters: RECALL_CONVERSATION_SUMMARY_INPUT_SCHEMA as unknown as Record<string, unknown>,
    },
  ];
  const composio = rawTools.map((t) => ({
    name: t.slug,
    description: (t.description ?? "").slice(0, 4096),
    parameters: (t.input_parameters ?? t.input_schema ?? t.parameters ?? {
      type: "object",
      properties: {},
    }) as Record<string, unknown>,
  }));
  const all = [...builtIn, ...composio];
  if (all.length === 0) return [];
  return [{ functionDeclarations: all }];
}

function extractGeminiFunctionCallsFromCandidate(
  cand: Record<string, unknown> | null
): Record<string, unknown>[] {
  if (!cand) return [];
  const content = cand["content"] as Record<string, unknown> | undefined;
  const parts = content?.["parts"] as Array<Record<string, unknown>> | undefined;
  const out: Record<string, unknown>[] = [];
  for (const p of parts ?? []) {
    const fc = p["functionCall"] as Record<string, unknown> | undefined;
    if (fc && typeof fc["name"] === "string") out.push(fc);
  }
  return out;
}

/** One Gemini streamGenerateContent turn; streams text deltas; returns function calls from final candidate. */
async function runGeminiTurnStreaming(
  model: string,
  contents: GeminiContent[],
  toolsPayload: unknown[] | null,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  userTimeZone?: string,
  pastConversationSummaries?: PastConversationSummary[] | null,
): Promise<{
  functionCallsRaw: Record<string, unknown>[];
  usage: { tokensIn: number; tokensOut: number };
}> {
  const body: Record<string, unknown> = {
    systemInstruction: {
      parts: [
        {
          text: buildSystemPrompt({
            userTimeZone,
            pastConversationSummaries,
          }),
        },
      ],
    },
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
  };
  if (toolsPayload && toolsPayload.length > 0) {
    body.tools = toolsPayload;
    body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${process.env.GOOGLE_GENERATIVE_AI_API_KEY}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
  );

  if (!response.ok || !response.body) {
    const err = await response.text();
    throw Object.assign(new Error(`Gemini error ${response.status}`), { status: response.status, body: err });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let textSnapshot = "";
  let lastCandidate: Record<string, unknown> | null = null;
  let lastPromptTokens = 0;
  let lastCandidatesTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(payload);
      } catch {
        continue;
      }

      const err = ev["error"] as Record<string, unknown> | undefined;
      if (err) {
        throw new Error(`Gemini stream error: ${JSON.stringify(err)}`);
      }

      const um = ev["usageMetadata"] as Record<string, unknown> | undefined;
      if (um) {
        const p = um["promptTokenCount"];
        const c = um["candidatesTokenCount"];
        if (typeof p === "number") lastPromptTokens = p;
        if (typeof c === "number") lastCandidatesTokens = c;
      }

      const candidates = ev["candidates"] as Array<Record<string, unknown>> | undefined;
      const cand = candidates?.[0];
      if (cand) lastCandidate = cand;

      const parts = (cand?.["content"] as Record<string, unknown> | undefined)?.["parts"] as
        | Array<Record<string, unknown>>
        | undefined;
      if (!parts?.length) continue;

      let chunkText = "";
      for (const p of parts) {
        if (typeof p["text"] === "string") chunkText += p["text"];
      }
      if (!chunkText) continue;

      if (chunkText.startsWith(textSnapshot)) {
        const delta = chunkText.slice(textSnapshot.length);
        textSnapshot = chunkText;
        if (delta) emitText(controller, encoder, delta);
      } else {
        textSnapshot += chunkText;
        emitText(controller, encoder, chunkText);
      }
    }
  }

  return {
    functionCallsRaw: extractGeminiFunctionCallsFromCandidate(lastCandidate),
    usage: { tokensIn: lastPromptTokens, tokensOut: lastCandidatesTokens },
  };
}

const handleGoogleMCPChat = httpAction(async (ctx, request) => {
  const req = (await request.json()) as MCPChatRequest;
  const {
    message,
    model = "gemini-2.5-flash",
    history = [],
    entityId = "default",
  } = req;
  const userTz = normalizedUserTimeZone(req.userTimeZone);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const [rawTools, pastSummaries] = await Promise.all([
          fetchComposioTools(entityId).catch(() => [] as ComposioTool[]),
          fetchPastConversationSummariesForPrompt(ctx, entityId, 3),
        ]);
        const geminiTools = buildGeminiTools(rawTools);
        console.log(
          `[/chat/google-mcp] Composio tools: ${rawTools.length}, past summaries: ${pastSummaries.length}`,
        );

        const trimmedHistory = trimHistoryForMCP(history);
        const contents: GeminiContent[] = [
          ...trimmedHistory.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          })),
          { role: "user", parts: [{ text: message }] },
        ];

        const MAX_TURNS = 8;
        let totalTokensIn = 0;
        let totalTokensOut = 0;

        for (let t = 0; t < MAX_TURNS; t++) {
          const { functionCallsRaw, usage } = await runGeminiTurnStreaming(
            model,
            contents,
            geminiTools.length > 0 ? geminiTools : null,
            controller,
            encoder,
            userTz,
            pastSummaries,
          );
          totalTokensIn += usage.tokensIn;
          totalTokensOut += usage.tokensOut;

          if (functionCallsRaw.length === 0) break;

          // Emit tool_start for each call so the UI can show progress.
          for (const fc of functionCallsRaw) {
            const args = (fc["args"] ?? fc["arguments"] ?? {}) as Record<string, unknown>;
            emitEvent(controller, encoder, {
              tool_start: {
                name: fc["name"] as string,
                id: (fc["id"] as string) ?? null,
                input: args,
              },
            });
          }

          const toolResults = await Promise.all(
            functionCallsRaw.map(async (fc) => {
              const name = fc["name"] as string;
              const args = (fc["args"] ?? fc["arguments"] ?? {}) as Record<string, unknown>;
              let execData: unknown;
              if (isBuiltInToolName(name)) {
                execData = await executeBuiltInTool(ctx, name, args, entityId);
              } else {
                execData = await executeComposioTool(name, args, entityId).catch((err) => ({
                  error: String(err),
                }));
              }
              const ok = !(execData && typeof execData === "object" && "error" in execData);
              emitEvent(controller, encoder, {
                tool_end: { name, id: (fc["id"] as string) ?? null, ok },
              });
              const sanitized = sanitizeToolResultForModel(name, execData);
              console.log(`[/chat/google-mcp] executed ${name}:`, JSON.stringify(sanitized).slice(0, 200));
              return sanitized;
            })
          );

          contents.push({
            role: "model",
            parts: functionCallsRaw.map((fc) => ({ functionCall: fc })),
          });
          contents.push({
            role: "user",
            parts: functionCallsRaw.map((fc, i) => {
              const name = fc["name"] as string;
              const part: Record<string, unknown> = {
                name,
                response: { result: toolResults[i] },
              };
              if (typeof fc["id"] === "string") part.id = fc["id"];
              return { functionResponse: part };
            }),
          });
        }

        emitUsageSummary(controller, encoder, {
          tokensIn: totalTokensIn,
          tokensOut: totalTokensOut,
          model,
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        console.error("[/chat/google-mcp] error:", err);
        try {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch {
          /* ignore */
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      "connection": "keep-alive",
    },
  });
});

// ─── Streaming agentic turn helpers ──────────────────────────────────────────

// Runs one Anthropic turn with stream:true, forwarding text deltas to the SSE
// controller immediately. Returns the full reconstructed content + stop reason
// so the caller can decide whether to loop (tool_use) or finish.
async function runAnthropicTurnStreaming(
  reqBody: Record<string, unknown>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder
): Promise<{
  allContent: AnthropicContentBlock[];
  stopReason: string;
  usage: { tokensIn: number; tokensOut: number };
}> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...reqBody, stream: true }),
  });

  if (!response.ok || !response.body) {
    const err = await response.text();
    throw Object.assign(new Error(`Anthropic error ${response.status}`), { status: response.status, body: err });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  type RawBlock =
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; inputJson: string };
  const blocks: RawBlock[] = [];
  let stopReason = "end_turn";
  let inputTokens = 0;
  let outputTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(payload); } catch { continue; }

      if (ev.type === "message_start") {
        const msg = ev.message as Record<string, unknown> | undefined;
        const u = msg?.usage as Record<string, unknown> | undefined;
        const tin = u?.input_tokens;
        if (typeof tin === "number") inputTokens = tin;
      }

      if (ev.type === "content_block_start") {
        const idx = ev.index as number;
        const cb = ev.content_block as Record<string, unknown>;
        if (cb.type === "text") blocks[idx] = { type: "text", text: "" };
        else if (cb.type === "tool_use")
          blocks[idx] = { type: "tool_use", id: cb.id as string, name: cb.name as string, inputJson: "" };
      } else if (ev.type === "content_block_delta") {
        const idx = ev.index as number;
        const delta = ev.delta as Record<string, unknown>;
        const blk = blocks[idx];
        if (blk?.type === "text" && delta.type === "text_delta") {
          const chunk = delta.text as string;
          blk.text += chunk;
          emitText(controller, encoder, chunk);
        } else if (blk?.type === "tool_use" && delta.type === "input_json_delta") {
          blk.inputJson += delta.partial_json as string;
        }
      } else if (ev.type === "message_delta") {
        const d = ev.delta as Record<string, unknown>;
        stopReason = (d.stop_reason as string) ?? "end_turn";
        const u = ev.usage as Record<string, unknown> | undefined;
        const tout = u?.output_tokens;
        if (typeof tout === "number") outputTokens = tout;
      }
    }
  }

  const allContent: AnthropicContentBlock[] = blocks.map((b) => {
    if (b.type === "text") return { type: "text", text: b.text };
    return {
      type: "tool_use",
      id: b.id,
      name: b.name,
      input: (() => { try { return JSON.parse(b.inputJson); } catch { return {}; } })() as Record<string, unknown>,
    };
  });

  return { allContent, stopReason, usage: { tokensIn: inputTokens, tokensOut: outputTokens } };
}

// Runs one OpenAI turn with stream:true, forwarding text deltas immediately.
// Returns reconstructed assistant content + tool calls + finish reason.
async function runOpenAITurnStreaming(
  reqBody: Record<string, unknown>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder
): Promise<{
  assistantContent: string | null;
  toolCalls: OpenAIToolCall[];
  finishReason: string;
  usage: { tokensIn: number; tokensOut: number };
}> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...reqBody,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  if (!response.ok || !response.body) {
    const err = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${err}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  let assistantContent = "";
  const toolCallsMap: Record<number, { id: string; name: string; argumentsJson: string }> = {};
  let finishReason = "stop";
  let promptTokens = 0;
  let completionTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(payload); } catch { continue; }

      const usage = ev.usage as Record<string, unknown> | undefined;
      if (usage) {
        const pt = usage.prompt_tokens;
        const ct = usage.completion_tokens;
        if (typeof pt === "number") promptTokens = pt;
        if (typeof ct === "number") completionTokens = ct;
      }

      const choices = ev.choices as Array<Record<string, unknown>> | undefined;
      if (!choices?.length) continue;
      const choice = choices[0];
      const delta = choice.delta as Record<string, unknown> | undefined;

      const content = delta?.content as string | null | undefined;
      if (content) {
        assistantContent += content;
        emitText(controller, encoder, content);
      }

      const tcDeltas = delta?.tool_calls as Array<Record<string, unknown>> | undefined;
      if (tcDeltas) {
        for (const tc of tcDeltas) {
          const idx = tc.index as number;
          if (!toolCallsMap[idx]) toolCallsMap[idx] = { id: "", name: "", argumentsJson: "" };
          const fn = tc.function as Record<string, unknown> | undefined;
          if (tc.id) toolCallsMap[idx].id = tc.id as string;
          if (fn?.name) toolCallsMap[idx].name = fn.name as string;
          if (fn?.arguments) toolCallsMap[idx].argumentsJson += fn.arguments as string;
        }
      }

      if (choice.finish_reason) finishReason = choice.finish_reason as string;
    }
  }

  const toolCalls: OpenAIToolCall[] = Object.values(toolCallsMap).map((tc) => ({
    id: tc.id,
    function: { name: tc.name, arguments: tc.argumentsJson },
  }));

  return {
    assistantContent: assistantContent || null,
    toolCalls,
    finishReason,
    usage: { tokensIn: promptTokens, tokensOut: completionTokens },
  };
}

const handleAnthropicMCPChat = httpAction(async (ctx, request) => {
  const req = (await request.json()) as MCPChatRequest;
  const {
    message,
    model = "claude-sonnet-4-6",
    history = [],
    entityId = "default",
  } = req;
  const userTz = normalizedUserTimeZone(req.userTimeZone);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const [rawTools, pastSummaries] = await Promise.all([
          fetchComposioTools(entityId).catch(() => [] as ComposioTool[]),
          fetchPastConversationSummariesForPrompt(ctx, entityId, 3),
        ]);
        // Build the tool list. Built-in tools (e.g. take_screenshot) are
        // always available; Composio tools are appended after them.
        const builtInAnthropicTools: Array<Record<string, unknown>> = [
          {
            name: TAKE_SCREENSHOT_NAME,
            description: TAKE_SCREENSHOT_DESCRIPTION,
            input_schema: TAKE_SCREENSHOT_INPUT_SCHEMA as unknown as Record<string, unknown>,
          },
          {
            name: SEARCH_CHAT_MEMORY_NAME,
            description: SEARCH_CHAT_MEMORY_DESCRIPTION,
            input_schema: SEARCH_CHAT_MEMORY_INPUT_SCHEMA as unknown as Record<string, unknown>,
          },
          {
            name: RECALL_USER_MEMORIES_NAME,
            description: RECALL_USER_MEMORIES_DESCRIPTION,
            input_schema: RECALL_USER_MEMORIES_INPUT_SCHEMA as unknown as Record<string, unknown>,
          },
          {
            name: RECALL_CONVERSATION_SUMMARY_NAME,
            description: RECALL_CONVERSATION_SUMMARY_DESCRIPTION,
            input_schema: RECALL_CONVERSATION_SUMMARY_INPUT_SCHEMA as unknown as Record<string, unknown>,
          },
        ];

        const composioAnthropicTools = buildComposioAnthropicTools(rawTools);

        const anthropicTools: Array<Record<string, unknown>> = [
          ...builtInAnthropicTools,
          ...composioAnthropicTools,
        ];
        // Mark the LAST tool with cache_control so Anthropic caches the
        // entire tools+system prefix. On follow-up messages within ~5
        // minutes, this is a cache hit and TTFT drops dramatically (and
        // you pay 1/10th for the cached tokens).
        if (anthropicTools.length > 0) {
          anthropicTools[anthropicTools.length - 1].cache_control = { type: "ephemeral" };
        }
        const toolListChars = JSON.stringify(anthropicTools).length;
        console.log(
          `[/chat/anthropic-mcp] ${anthropicTools.length} tools, ~${toolListChars} chars (~${Math.round(toolListChars / 4)} est. tokens):`,
          anthropicTools.map((t) => t.name),
        );

        // System prompt as an array so we can attach cache_control. This
        // caches the system block separately (and the tools block builds on
        // top of it).
        const systemBlocks = [
          {
            type: "text" as const,
            text: buildSystemPrompt({
              userTimeZone: userTz,
              pastConversationSummaries: pastSummaries,
            }),
            cache_control: { type: "ephemeral" as const },
          },
        ];

        type ConvMessage = { role: string; content: unknown };
        const trimmedHistory = trimHistoryForMCP(history);
        const messages: ConvMessage[] = [
          ...trimmedHistory.map((m) => ({ role: m.role as string, content: m.content as unknown })),
          { role: "user", content: message },
        ];

        const MAX_TURNS = 8;
        let totalTokensIn = 0;
        let totalTokensOut = 0;

        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const reqBody: Record<string, unknown> = {
            model,
            max_tokens: 4096,
            system: systemBlocks,
            messages,
          };
          if (anthropicTools.length > 0) reqBody.tools = anthropicTools;

          const { allContent, stopReason, usage } = await runAnthropicTurnStreaming(
            reqBody,
            controller,
            encoder
          );
          totalTokensIn += usage.tokensIn;
          totalTokensOut += usage.tokensOut;

          if (stopReason !== "tool_use") break;

          const toolUseBlocks = allContent.filter(
            (b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
              b.type === "tool_use"
          );

          // Tell the UI which tools are starting before we await them.
          // For built-in tools we forward the input so the client can act
          // on it (e.g. capture+locate for take_screenshot).
          for (const toolUse of toolUseBlocks) {
            emitEvent(controller, encoder, {
              tool_start: {
                name: toolUse.name,
                id: toolUse.id,
                input: toolUse.input ?? {},
              },
            });
          }

          const toolResults = await Promise.all(
            toolUseBlocks.map(async (toolUse) => {
              let execData: unknown;
              if (isBuiltInToolName(toolUse.name)) {
                execData = await executeBuiltInTool(
                  ctx,
                  toolUse.name,
                  toolUse.input ?? {},
                  entityId
                );
              } else {
                execData = await executeComposioTool(toolUse.name, toolUse.input, entityId).catch(
                  (err) => ({ error: String(err) })
                );
              }
              const ok = !(execData && typeof execData === "object" && "error" in execData);
              emitEvent(controller, encoder, {
                tool_end: { name: toolUse.name, id: toolUse.id, ok },
              });
              const sanitized = sanitizeToolResultForModel(toolUse.name, execData);
              console.log(
                `[/chat/anthropic-mcp] executed ${toolUse.name}:`,
                JSON.stringify(sanitized).slice(0, 200),
              );
              return {
                type: "tool_result" as const,
                tool_use_id: toolUse.id,
                content: JSON.stringify(sanitized),
              };
            })
          );

          messages.push({ role: "assistant", content: allContent });
          messages.push({ role: "user", content: toolResults });
        }

        emitUsageSummary(controller, encoder, {
          tokensIn: totalTokensIn,
          tokensOut: totalTokensOut,
          model,
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        console.error("[/chat/anthropic-mcp] error:", err);
        try { controller.enqueue(encoder.encode("data: [DONE]\n\n")); } catch { /* ignore */ }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      "connection": "keep-alive",
    },
  });
});

// ─── /chat/openai-tools ───────────────────────────────────────────────────────
// Calls GPT with Composio tools via OpenAI function-calling agentic loop.

type OpenAIToolCall = { id: string; function: { name: string; arguments: string } };
type OpenAIMessage =
  | { role: "system" | "user" | "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

const handleOpenAIToolsChat = httpAction(async (ctx, request) => {
  const req = (await request.json()) as MCPChatRequest;
  const {
    message,
    model = "gpt-4o",
    history = [],
    entityId = "default",
  } = req;
  const userTz = normalizedUserTimeZone(req.userTimeZone);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const [rawTools, pastSummaries] = await Promise.all([
          fetchComposioTools(entityId).catch(() => [] as ComposioTool[]),
          fetchPastConversationSummariesForPrompt(ctx, entityId, 3),
        ]);
        const builtInOpenAITools = [
          {
            type: "function" as const,
            function: {
              name: TAKE_SCREENSHOT_NAME,
              description: TAKE_SCREENSHOT_DESCRIPTION,
              parameters: TAKE_SCREENSHOT_INPUT_SCHEMA as unknown as Record<string, unknown>,
            },
          },
          {
            type: "function" as const,
            function: {
              name: SEARCH_CHAT_MEMORY_NAME,
              description: SEARCH_CHAT_MEMORY_DESCRIPTION,
              parameters: SEARCH_CHAT_MEMORY_INPUT_SCHEMA as unknown as Record<string, unknown>,
            },
          },
          {
            type: "function" as const,
            function: {
              name: RECALL_USER_MEMORIES_NAME,
              description: RECALL_USER_MEMORIES_DESCRIPTION,
              parameters: RECALL_USER_MEMORIES_INPUT_SCHEMA as unknown as Record<string, unknown>,
            },
          },
          {
            type: "function" as const,
            function: {
              name: RECALL_CONVERSATION_SUMMARY_NAME,
              description: RECALL_CONVERSATION_SUMMARY_DESCRIPTION,
              parameters: RECALL_CONVERSATION_SUMMARY_INPUT_SCHEMA as unknown as Record<string, unknown>,
            },
          },
        ];
        const composioOpenAITools = rawTools.map((t) => ({
          type: "function" as const,
          function: {
            name: t.slug,
            description: t.description ?? "",
            parameters: (t.input_parameters ?? t.input_schema ?? t.parameters ?? {
              type: "object",
              properties: {},
            }) as Record<string, unknown>,
          },
        }));
        const openaiTools = [...builtInOpenAITools, ...composioOpenAITools];
        console.log(
          `[/chat/openai-tools] ${openaiTools.length} tools, past summaries: ${pastSummaries.length}`,
          openaiTools.map((t) => t.function.name),
        );

        const trimmedHistory = trimHistoryForMCP(history);
        const messages: OpenAIMessage[] = [
          {
            role: "system",
            content: buildSystemPrompt({
              userTimeZone: userTz,
              pastConversationSummaries: pastSummaries,
            }),
          },
          ...trimmedHistory.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
            tool_calls: undefined,
          })),
          { role: "user", content: message },
        ];

        const MAX_TURNS = 8;
        let totalTokensIn = 0;
        let totalTokensOut = 0;

        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const reqBody: Record<string, unknown> = { model, messages };
          if (openaiTools.length > 0) reqBody.tools = openaiTools;

          const { assistantContent, toolCalls, finishReason, usage } = await runOpenAITurnStreaming(
            reqBody,
            controller,
            encoder
          );
          totalTokensIn += usage.tokensIn;
          totalTokensOut += usage.tokensOut;

          if (finishReason !== "tool_calls") break;

          for (const tc of toolCalls) {
            let parsedInput: Record<string, unknown> = {};
            try { parsedInput = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { /* ignore */ }
            emitEvent(controller, encoder, {
              tool_start: { name: tc.function.name, id: tc.id, input: parsedInput },
            });
          }

          const toolResults = await Promise.all(
            toolCalls.map(async (tc) => {
              let args: Record<string, unknown> = {};
              try { args = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { /* ignore */ }
              let execData: unknown;
              if (isBuiltInToolName(tc.function.name)) {
                execData = await executeBuiltInTool(ctx, tc.function.name, args, entityId);
              } else {
                execData = await executeComposioTool(tc.function.name, args, entityId).catch(
                  (err) => ({ error: String(err) })
                );
              }
              const ok = !(execData && typeof execData === "object" && "error" in execData);
              emitEvent(controller, encoder, {
                tool_end: { name: tc.function.name, id: tc.id, ok },
              });
              const sanitized = sanitizeToolResultForModel(tc.function.name, execData);
              console.log(
                `[/chat/openai-tools] executed ${tc.function.name}:`,
                JSON.stringify(sanitized).slice(0, 200),
              );
              return {
                role: "tool" as const,
                tool_call_id: tc.id,
                content: JSON.stringify(sanitized),
              };
            })
          );

          messages.push({ role: "assistant", content: assistantContent, tool_calls: toolCalls });
          messages.push(...toolResults);
        }

        emitUsageSummary(controller, encoder, {
          tokensIn: totalTokensIn,
          tokensOut: totalTokensOut,
          model,
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        console.error("[/chat/openai-tools] error:", err);
        try { controller.enqueue(encoder.encode("data: [DONE]\n\n")); } catch { /* ignore */ }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      "connection": "keep-alive",
    },
  });
});

// ─── Register ─────────────────────────────────────────────────────────────────

export function registerChatRoutes(http: HttpRouter) {
  http.route({ path: "/chat/google", method: "POST", handler: handleGoogleChat });
  http.route({ path: "/chat/google-mcp", method: "POST", handler: handleGoogleMCPChat });
  http.route({ path: "/chat/anthropic", method: "POST", handler: handleAnthropicChat });
  http.route({ path: "/chat/anthropic-mcp", method: "POST", handler: handleAnthropicMCPChat });
  http.route({ path: "/chat/openai", method: "POST", handler: handleOpenAIChat });
  http.route({ path: "/chat/openai-tools", method: "POST", handler: handleOpenAIToolsChat });
}