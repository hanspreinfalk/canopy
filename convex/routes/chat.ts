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

const COMPOSIO_BASE = "https://backend.composio.dev";

function composioHeaders() {
  return { "x-api-key": process.env.COMPOSIO_API_KEY!, "Content-Type": "application/json" };
}

const handleAnthropicMCPChat = httpAction(async (_ctx, request) => {
  const {
    message,
    model = "claude-opus-4-7",
    history = [],
    entityId = "default",
  } = (await request.json()) as MCPChatRequest;

  // Fetch only tools from apps the user has actually connected
  let anthropicTools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }> = [];
  try {
    // 1. Get the user's active connections to know which toolkits are connected
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
    console.log(`[/chat/anthropic-mcp] connected toolkits for ${entityId}:`, connectedSlugs);

    if (connectedSlugs.length > 0) {
      // 2. Fetch tools per connected toolkit using singular toolkit_slug param
      const toolArrays = await Promise.all(
        connectedSlugs.map(async (slug) => {
          const resp = await fetch(
            `${COMPOSIO_BASE}/api/v3/tools?toolkit_slug=${encodeURIComponent(slug)}&limit=100`,
            { headers: composioHeaders() }
          );
          if (!resp.ok) {
            console.warn(`[/chat/anthropic-mcp] tools fetch failed for ${slug}: ${resp.status}`);
            return [] as ComposioTool[];
          }
          const data = (await resp.json()) as { items?: ComposioTool[] };
          return data.items ?? [];
        })
      );
      const allTools = toolArrays.flat();
      anthropicTools = allTools.map((t) => ({
        name: t.slug,
        description: t.description ?? "",
        input_schema: (t.input_parameters ?? t.input_schema ?? t.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>,
      }));
      console.log(`[/chat/anthropic-mcp] loaded ${anthropicTools.length} tools:`, anthropicTools.map((t) => t.name));
    } else {
      console.log("[/chat/anthropic-mcp] no connected apps — proceeding without tools");
    }
  } catch (err) {
    console.warn("[/chat/anthropic-mcp] could not fetch tools:", err);
  }

  // Build the message array for the agentic loop
  type ConvMessage = { role: string; content: unknown };
  const messages: ConvMessage[] = [
    ...history.map((m) => ({ role: m.role as string, content: m.content as unknown })),
    { role: "user", content: message },
  ];

  let finalText = "";
  const MAX_TURNS = 8;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const reqBody: Record<string, unknown> = { model, max_tokens: 4096, messages };
    if (anthropicTools.length > 0) reqBody.tools = anthropicTools;

    const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(reqBody),
    });

    if (!claudeResp.ok) {
      const err = await claudeResp.text();
      console.error(`[/chat/anthropic-mcp] Claude error ${claudeResp.status}: ${err}`);
      return new Response(err, { status: claudeResp.status, headers: { "content-type": "application/json" } });
    }

    const claudeData = (await claudeResp.json()) as AnthropicMessage;

    if (claudeData.stop_reason !== "tool_use") {
      finalText = claudeData.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      break;
    }

    // Execute all tool_use blocks in parallel
    const toolUseBlocks = claudeData.content.filter(
      (b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
        b.type === "tool_use"
    );

    const toolResults = await Promise.all(
      toolUseBlocks.map(async (toolUse) => {
        try {
          const execResp = await fetch(`${COMPOSIO_BASE}/api/v3/tools/execute/${toolUse.name}`, {
            method: "POST",
            headers: composioHeaders(),
            body: JSON.stringify({ arguments: toolUse.input, user_id: entityId }),
          });
          const execData = execResp.ok ? await execResp.json() : { error: `HTTP ${execResp.status}` };
          console.log(`[/chat/anthropic-mcp] executed ${toolUse.name}:`, JSON.stringify(execData).slice(0, 200));
          return { type: "tool_result" as const, tool_use_id: toolUse.id, content: JSON.stringify(execData) };
        } catch (err) {
          return { type: "tool_result" as const, tool_use_id: toolUse.id, content: `Error: ${err}` };
        }
      })
    );

    messages.push({ role: "assistant", content: claudeData.content });
    messages.push({ role: "user", content: toolResults });
  }

  // Emit final text as normalized SSE
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (finalText) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: finalText })}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
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
}
