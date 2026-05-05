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

// ─── Register ─────────────────────────────────────────────────────────────────

export function registerChatRoutes(http: HttpRouter) {
  http.route({ path: "/chat/google", method: "POST", handler: handleGoogleChat });
  http.route({ path: "/chat/anthropic", method: "POST", handler: handleAnthropicChat });
  http.route({ path: "/chat/openai", method: "POST", handler: handleOpenAIChat });
}
