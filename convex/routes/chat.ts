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
type NormalizedChatRequest = { message: string; model?: string; history?: HistoryMessage[] };
type MCPChatRequest = NormalizedChatRequest & { entityId?: string };

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
  const { message, model = "gemini-2.5-flash", history = [] } =
    (await request.json()) as NormalizedChatRequest;

  const historyContents = history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
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
  const { message, model = "claude-sonnet-4-6", history = [] } =
    (await request.json()) as NormalizedChatRequest;

  const body = JSON.stringify({
    model,
    max_tokens: 1024,
    stream: true,
    system: buildSystemPrompt(),
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
  const { message, model = "gpt-4o", history = [] } =
    (await request.json()) as NormalizedChatRequest;

  const body = JSON.stringify({
    model,
    stream: true,
    messages: [
      { role: "system", content: buildSystemPrompt() },
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

// ─── /chat/anthropic-mcp ──────────────────────────────────────────────────────
// Calls Claude in an agentic loop with the user's Composio tools.
// 1. Fetch the user's active tools from Composio REST API.
// 2. Pass them to Claude as regular `tools`.
// 3. Execute any tool_use blocks via Composio execute endpoint.
// 4. Loop until Claude stops with end_turn or no tools were available.
// 5. Emit the final text as a single SSE chunk.

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

type AnthropicMessage = {
  stop_reason: string;
  content: AnthropicContentBlock[];
};

function buildSystemPrompt(): string {
  return `The current date and time is ${new Date().toUTCString()}.`;
}

const COMPOSIO_BASE = "https://backend.composio.dev";

function composioHeaders() {
  return { "x-api-key": process.env.COMPOSIO_API_KEY!, "Content-Type": "application/json" };
}

// Shared helper: fetch tools for all of a user's active connected toolkits.
async function fetchComposioTools(entityId: string): Promise<ComposioTool[]> {
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

// ─── Streaming agentic turn helpers ──────────────────────────────────────────

// Runs one Anthropic turn with stream:true, forwarding text deltas to the SSE
// controller immediately. Returns the full reconstructed content + stop reason
// so the caller can decide whether to loop (tool_use) or finish.
async function runAnthropicTurnStreaming(
  reqBody: Record<string, unknown>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder
): Promise<{ allContent: AnthropicContentBlock[]; stopReason: string }> {
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
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: chunk })}\n\n`));
        } else if (blk?.type === "tool_use" && delta.type === "input_json_delta") {
          blk.inputJson += delta.partial_json as string;
        }
      } else if (ev.type === "message_delta") {
        const d = ev.delta as Record<string, unknown>;
        stopReason = (d.stop_reason as string) ?? "end_turn";
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

  return { allContent, stopReason };
}

// Runs one OpenAI turn with stream:true, forwarding text deltas immediately.
// Returns reconstructed assistant content + tool calls + finish reason.
async function runOpenAITurnStreaming(
  reqBody: Record<string, unknown>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder
): Promise<{ assistantContent: string | null; toolCalls: OpenAIToolCall[]; finishReason: string }> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...reqBody, stream: true }),
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

      const choices = ev.choices as Array<Record<string, unknown>> | undefined;
      if (!choices?.length) continue;
      const choice = choices[0];
      const delta = choice.delta as Record<string, unknown> | undefined;

      const content = delta?.content as string | null | undefined;
      if (content) {
        assistantContent += content;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: content })}\n\n`));
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

  return { assistantContent: assistantContent || null, toolCalls, finishReason };
}

const handleAnthropicMCPChat = httpAction(async (_ctx, request) => {
  const {
    message,
    model = "claude-opus-4-7",
    history = [],
    entityId = "default",
  } = (await request.json()) as MCPChatRequest;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const rawTools = await fetchComposioTools(entityId).catch(() => [] as ComposioTool[]);
        const anthropicTools = rawTools.map((t) => ({
          name: t.slug,
          description: t.description ?? "",
          input_schema: (t.input_parameters ?? t.input_schema ?? t.parameters ?? {
            type: "object",
            properties: {},
          }) as Record<string, unknown>,
        }));
        console.log(`[/chat/anthropic-mcp] ${anthropicTools.length} tools:`, anthropicTools.map((t) => t.name));

        type ConvMessage = { role: string; content: unknown };
        const messages: ConvMessage[] = [
          ...history.map((m) => ({ role: m.role as string, content: m.content as unknown })),
          { role: "user", content: message },
        ];

        const MAX_TURNS = 8;

        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const reqBody: Record<string, unknown> = { model, max_tokens: 4096, system: buildSystemPrompt(), messages };
          if (anthropicTools.length > 0) reqBody.tools = anthropicTools;

          const { allContent, stopReason } = await runAnthropicTurnStreaming(reqBody, controller, encoder);

          if (stopReason !== "tool_use") break;

          const toolUseBlocks = allContent.filter(
            (b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
              b.type === "tool_use"
          );

          const toolResults = await Promise.all(
            toolUseBlocks.map(async (toolUse) => {
              const execData = await executeComposioTool(toolUse.name, toolUse.input, entityId).catch(
                (err) => ({ error: String(err) })
              );
              console.log(`[/chat/anthropic-mcp] executed ${toolUse.name}:`, JSON.stringify(execData).slice(0, 200));
              return { type: "tool_result" as const, tool_use_id: toolUse.id, content: JSON.stringify(execData) };
            })
          );

          messages.push({ role: "assistant", content: allContent });
          messages.push({ role: "user", content: toolResults });
        }

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
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
});

// ─── /chat/openai-tools ───────────────────────────────────────────────────────
// Calls GPT with Composio tools via OpenAI function-calling agentic loop.

type OpenAIToolCall = { id: string; function: { name: string; arguments: string } };
type OpenAIMessage =
  | { role: "system" | "user" | "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

const handleOpenAIToolsChat = httpAction(async (_ctx, request) => {
  const {
    message,
    model = "gpt-4o",
    history = [],
    entityId = "default",
  } = (await request.json()) as MCPChatRequest;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const rawTools = await fetchComposioTools(entityId).catch(() => [] as ComposioTool[]);
        const openaiTools = rawTools.map((t) => ({
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
        console.log(`[/chat/openai-tools] ${openaiTools.length} tools:`, openaiTools.map((t) => t.function.name));

        const messages: OpenAIMessage[] = [
          { role: "system", content: buildSystemPrompt() },
          ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content, tool_calls: undefined })),
          { role: "user", content: message },
        ];

        const MAX_TURNS = 8;

        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const reqBody: Record<string, unknown> = { model, messages };
          if (openaiTools.length > 0) reqBody.tools = openaiTools;

          const { assistantContent, toolCalls, finishReason } = await runOpenAITurnStreaming(reqBody, controller, encoder);

          if (finishReason !== "tool_calls") break;

          const toolResults = await Promise.all(
            toolCalls.map(async (tc) => {
              const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
              const execData = await executeComposioTool(tc.function.name, args, entityId).catch(
                (err) => ({ error: String(err) })
              );
              console.log(`[/chat/openai-tools] executed ${tc.function.name}:`, JSON.stringify(execData).slice(0, 200));
              return { role: "tool" as const, tool_call_id: tc.id, content: JSON.stringify(execData) };
            })
          );

          messages.push({ role: "assistant", content: assistantContent, tool_calls: toolCalls });
          messages.push(...toolResults);
        }

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
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
});

// ─── Register ─────────────────────────────────────────────────────────────────

export function registerChatRoutes(http: HttpRouter) {
  http.route({ path: "/chat/google", method: "POST", handler: handleGoogleChat });
  http.route({ path: "/chat/anthropic", method: "POST", handler: handleAnthropicChat });
  http.route({ path: "/chat/anthropic-mcp", method: "POST", handler: handleAnthropicMCPChat });
  http.route({ path: "/chat/openai", method: "POST", handler: handleOpenAIChat });
  http.route({ path: "/chat/openai-tools", method: "POST", handler: handleOpenAIToolsChat });
}
