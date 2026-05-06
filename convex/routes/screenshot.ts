import { httpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { SCREENSHOT_LOCATE_SYSTEM_PROMPT } from "../systemPrompts";

type HttpRouter = ReturnType<typeof httpRouter>;

// ─── /screenshot/locate ───────────────────────────────────────────────────────
//
// Receives a screenshot from the client + a natural-language description of
// what to point at, asks Claude Sonnet 4.6 to find the pixel center of that
// element, and returns coordinates the client can map back to global screen
// coords.
//
// Coordinate contract:
//   The client tells us the EXACT pixel dimensions of the JPEG it captured
//   (after any downscaling it did locally). Claude is instructed to reply
//   with [POINT:x,y:label] in that same pixel space, top-left origin. The
//   client owns the mapping from "pixel in this image" → "point in display"
//   → "global AppKit point", because only it knows the display geometry.
//
// We only echo what Claude returned (clamped) plus a normalized 0..1 form
// for clients that prefer that. We never store the screenshot.

type LocateRequest = {
  image: string; // base64-encoded JPEG, no "data:" prefix
  imageWidth: number;
  imageHeight: number;
  description: string;
  context?: string;
};

type LocateOk = {
  found: true;
  x: number;
  y: number;
  normalizedX: number;
  normalizedY: number;
  label: string | null;
  raw: string;
};
type LocateMiss = { found: false; reason: string; raw?: string };

const handleScreenshotLocate = httpAction(async (_ctx, request) => {
  let body: LocateRequest;
  try {
    body = (await request.json()) as LocateRequest;
  } catch {
    return jsonResponse({ found: false, reason: "Invalid JSON body" } as LocateMiss, 400);
  }

  if (
    !body.image ||
    !body.description ||
    !Number.isFinite(body.imageWidth) ||
    !Number.isFinite(body.imageHeight) ||
    body.imageWidth <= 0 ||
    body.imageHeight <= 0
  ) {
    return jsonResponse(
      { found: false, reason: "Missing image, dimensions, or description" } as LocateMiss,
      400
    );
  }

  const userMessage = `Image dimensions: ${body.imageWidth}x${body.imageHeight} pixels (top-left origin).${
    body.context ? "\nContext: " + body.context : ""
  }\n\nFind the pixel center of: ${body.description}\n\nReply with [POINT:x,y:label] or [POINT:none] only.`;

  const requestBody = {
    model: "claude-sonnet-4-6",
    max_tokens: 128,
    system: SCREENSHOT_LOCATE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: body.image,
            },
          },
          { type: "text", text: userMessage },
        ],
      },
    ],
  };

  let resp: Response;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    console.error("[/screenshot/locate] fetch error:", err);
    return jsonResponse(
      { found: false, reason: "Anthropic request failed" } as LocateMiss,
      502
    );
  }

  if (!resp.ok) {
    const errBody = await resp.text();
    console.error(
      `[/screenshot/locate] Anthropic error ${resp.status}: ${errBody.slice(0, 400)}`
    );
    return jsonResponse(
      { found: false, reason: `Anthropic error ${resp.status}` } as LocateMiss,
      502
    );
  }

  const data = (await resp.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const responseText =
    data.content
      ?.map((b) => (b.type === "text" ? b.text ?? "" : ""))
      .join("")
      .trim() ?? "";

  console.log(
    `[/screenshot/locate] description="${body.description.slice(0, 80)}" → "${responseText.slice(0, 200)}"`
  );

  const parsed = parsePointTag(responseText);
  if (!parsed) {
    return jsonResponse(
      { found: false, reason: "Model did not return a valid POINT tag", raw: responseText } as LocateMiss,
      200
    );
  }
  if (parsed === "none") {
    return jsonResponse(
      { found: false, reason: "Element not visible on screen", raw: responseText } as LocateMiss,
      200
    );
  }

  // Clamp to image bounds — Claude is allowed to occasionally over/undershoot,
  // and we want to keep clients honest about the coord space they sent.
  const x = clamp(parsed.x, 0, body.imageWidth - 1);
  const y = clamp(parsed.y, 0, body.imageHeight - 1);

  const payload: LocateOk = {
    found: true,
    x,
    y,
    normalizedX: x / body.imageWidth,
    normalizedY: y / body.imageHeight,
    label: parsed.label,
    raw: responseText,
  };
  return jsonResponse(payload, 200);
});

function parsePointTag(text: string):
  | { x: number; y: number; label: string | null }
  | "none"
  | null {
  const noneMatch = text.match(/\[POINT:\s*none\s*\]/i);
  if (noneMatch) return "none";

  const match = text.match(/\[POINT:\s*(-?\d+)\s*,\s*(-?\d+)(?:\s*:\s*([^\]]+))?\]/i);
  if (!match) return null;

  const x = parseInt(match[1], 10);
  const y = parseInt(match[2], 10);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  const label = (match[3] ?? "").trim();
  return { x, y, label: label.length > 0 ? label.slice(0, 80) : null };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function registerScreenshotRoutes(http: HttpRouter) {
  http.route({ path: "/screenshot/locate", method: "POST", handler: handleScreenshotLocate });
}
