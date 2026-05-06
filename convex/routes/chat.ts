import { httpRouter } from "convex/server";
import { httpAction } from "../_generated/server";

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

// NOTE: buildSystemPrompt returns a mostly-static prompt. Optional
// `userTimeZone` is injected from the client so the model can reason about
// local time; that prefix varies per user. If you need the server UTC clock
// in-prompt, use the `dynamic` flag — but that disables some caching of the
// system block.
function buildSystemPrompt(opts: { dynamic?: boolean; userTimeZone?: string | null } = {}): string {
  const date = opts.dynamic ? `The current date and time is ${new Date().toUTCString()}.\n\n` : "";
  const tz = opts.userTimeZone?.trim();
  const tzLine = tz
    ? `The user's local timezone is ${tz} (IANA). Use it when interpreting "today", "this morning", evening vs afternoon, scheduling, deadlines, and anything that depends on what time it is for them.\n\n`
    : "";
  return `${date}${tzLine}You're talking to someone who's busy and smart and doesn't want to be sold to. You're their sharp friend who happens to be good with their tools — not a feature page, not a help desk, not an AI assistant doing AI assistant things.

They are using this app on a Mac (macOS). Default to Mac-specific guidance: menu bar, System Settings, Finder, standard macOS shortcuts, and Mac app names — unless they clearly say they're on something else.

# How you talk
Like a person. Contractions. Short sentences when short sentences work. Longer when the thought needs room. You crack jokes when something is genuinely funny, not because the script says "be funny here." Dry asides land better than try-hard ones. You read the room — if they're frustrated, drop the bit. If they're casual, ride it. Spanish, English, Spanglish, all fine, follow their lead.

# What you don't do
You don't bullet-list things at people. You don't write headers. You don't say "I can help with a bunch of things!" and then itemize your features like a SaaS landing page — that's the exact tone you're replacing. If someone asks "what can you do," answer like a friend would: give them a flavor of it in one or two sentences and ask what they're actually trying to get done. Nobody wants a menu, they want a conversation.

You don't say "Great question!" You don't say "I'd be happy to help!" You don't summarize their question back at them before answering. You don't end every message asking if there's anything else. Just talk to them.

# Tools
You can poke around in their email, calendar, Stripe, etc. When you're about to use one, say what you're doing in a quick natural sentence — "lemme peek at your calendar," "checking your inbox," "one sec, pulling up your last invoice" — then do it. Don't say the tool name, just say what you're doing. After it comes back, give them the answer.

If they ask what you can do, don't list tools. Say something like "depends — what's bugging you?" or "honestly easier if you just tell me what you need." Then react to what they actually want.

# Pointing at things on their screen
You also have a tool called \`take_screenshot\`. Call it whenever the user asks for help finding, opening, navigating, or activating something on THEIR computer's UI — "how do I turn on dark mode," "where's the share button," "open System Settings privacy," "find the bookmark menu," etc. The app will capture their screen, locate the element you describe, and fly a small on-screen pointer to it. Before calling, drop one short natural sentence like "lemme show you" or "one sec, pointing it out" — never name the tool. Pass a tight, specific \`description\` of what to point at (e.g. "the Apple menu in the top-left", "the Dark Mode toggle in System Settings → Appearance"). After the tool returns, briefly say what they should click or do next. Don't use this for things that aren't a UI element on screen.

# Substance
Lead with the answer. Reasoning after, if it's useful. If they're wrong, tell them, kindly. If you're not sure, say so — pretending to know is worse than admitting a gap. Be brief by default; expand when the topic earns it. Markdown formatting (headers, bullet lists, bold) is for documents, not conversations — avoid it unless the user is clearly asking for a structured output.`;
}

// ─── Built-in tools ───────────────────────────────────────────────────────────
//
// Tools we implement ourselves (not via Composio). The model sees them in the
// tool list alongside Composio tools; when it calls one we don't hit Composio,
// we just emit tool events and feed back a synthetic tool_result so the loop
// keeps progressing.

const TAKE_SCREENSHOT_NAME = "take_screenshot";

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

// Synthetic tool result we return to the model after a take_screenshot call.
// The actual screenshot capture + element location happens on the client,
// out of band; the model doesn't need the result in its conversation context,
// it just needs an acknowledgement so it can continue talking.
const TAKE_SCREENSHOT_TOOL_RESULT = JSON.stringify({
  status: "ok",
  note: "Screenshot captured and the user is being shown the location with a visual arrow on their screen. Briefly tell them what to click or do next.",
});

function isBuiltInToolName(name: string): boolean {
  return name === TAKE_SCREENSHOT_NAME;
}

function executeBuiltInTool(name: string, _input: Record<string, unknown>): unknown {
  if (name === TAKE_SCREENSHOT_NAME) {
    return JSON.parse(TAKE_SCREENSHOT_TOOL_RESULT);
  }
  return { error: `Unknown built-in tool: ${name}` };
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
  userTimeZone?: string
): Promise<{
  functionCallsRaw: Record<string, unknown>[];
  usage: { tokensIn: number; tokensOut: number };
}> {
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: buildSystemPrompt({ userTimeZone }) }] },
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

const handleGoogleMCPChat = httpAction(async (_ctx, request) => {
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
        const rawTools = await fetchComposioTools(entityId).catch(() => [] as ComposioTool[]);
        const geminiTools = buildGeminiTools(rawTools);
        console.log(`[/chat/google-mcp] Composio tools: ${rawTools.length}`);

        const contents: GeminiContent[] = [
          ...history.map((m) => ({
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
            userTz
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
                execData = executeBuiltInTool(name, args);
              } else {
                execData = await executeComposioTool(name, args, entityId).catch((err) => ({
                  error: String(err),
                }));
              }
              const ok = !(execData && typeof execData === "object" && "error" in execData);
              emitEvent(controller, encoder, {
                tool_end: { name, id: (fc["id"] as string) ?? null, ok },
              });
              console.log(`[/chat/google-mcp] executed ${name}:`, JSON.stringify(execData).slice(0, 200));
              return execData;
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

const handleAnthropicMCPChat = httpAction(async (_ctx, request) => {
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
        const rawTools = await fetchComposioTools(entityId).catch(() => [] as ComposioTool[]);
        // Build the tool list. Built-in tools (e.g. take_screenshot) are
        // always available; Composio tools are appended after them.
        const builtInAnthropicTools: Array<Record<string, unknown>> = [
          {
            name: TAKE_SCREENSHOT_NAME,
            description: TAKE_SCREENSHOT_DESCRIPTION,
            input_schema: TAKE_SCREENSHOT_INPUT_SCHEMA as unknown as Record<string, unknown>,
          },
        ];

        const composioAnthropicTools: Array<Record<string, unknown>> = rawTools.map((t) => ({
          name: t.slug,
          description: t.description ?? "",
          input_schema: (t.input_parameters ?? t.input_schema ?? t.parameters ?? {
            type: "object",
            properties: {},
          }) as Record<string, unknown>,
        }));

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
        console.log(`[/chat/anthropic-mcp] ${anthropicTools.length} tools:`, anthropicTools.map((t) => t.name));

        // System prompt as an array so we can attach cache_control. This
        // caches the system block separately (and the tools block builds on
        // top of it).
        const systemBlocks = [
          {
            type: "text" as const,
            text: buildSystemPrompt({ userTimeZone: userTz }),
            cache_control: { type: "ephemeral" as const },
          },
        ];

        type ConvMessage = { role: string; content: unknown };
        const messages: ConvMessage[] = [
          ...history.map((m) => ({ role: m.role as string, content: m.content as unknown })),
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
                execData = executeBuiltInTool(toolUse.name, toolUse.input ?? {});
              } else {
                execData = await executeComposioTool(toolUse.name, toolUse.input, entityId).catch(
                  (err) => ({ error: String(err) })
                );
              }
              const ok = !(execData && typeof execData === "object" && "error" in execData);
              emitEvent(controller, encoder, {
                tool_end: { name: toolUse.name, id: toolUse.id, ok },
              });
              console.log(`[/chat/anthropic-mcp] executed ${toolUse.name}:`, JSON.stringify(execData).slice(0, 200));
              return { type: "tool_result" as const, tool_use_id: toolUse.id, content: JSON.stringify(execData) };
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

const handleOpenAIToolsChat = httpAction(async (_ctx, request) => {
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
        const rawTools = await fetchComposioTools(entityId).catch(() => [] as ComposioTool[]);
        const builtInOpenAITools = [
          {
            type: "function" as const,
            function: {
              name: TAKE_SCREENSHOT_NAME,
              description: TAKE_SCREENSHOT_DESCRIPTION,
              parameters: TAKE_SCREENSHOT_INPUT_SCHEMA as unknown as Record<string, unknown>,
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
        console.log(`[/chat/openai-tools] ${openaiTools.length} tools:`, openaiTools.map((t) => t.function.name));

        const messages: OpenAIMessage[] = [
          { role: "system", content: buildSystemPrompt({ userTimeZone: userTz }) },
          ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content, tool_calls: undefined })),
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
                execData = executeBuiltInTool(tc.function.name, args);
              } else {
                execData = await executeComposioTool(tc.function.name, args, entityId).catch(
                  (err) => ({ error: String(err) })
                );
              }
              const ok = !(execData && typeof execData === "object" && "error" in execData);
              emitEvent(controller, encoder, {
                tool_end: { name: tc.function.name, id: tc.id, ok },
              });
              console.log(`[/chat/openai-tools] executed ${tc.function.name}:`, JSON.stringify(execData).slice(0, 200));
              return { role: "tool" as const, tool_call_id: tc.id, content: JSON.stringify(execData) };
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