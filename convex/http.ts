import { verifyWebhook } from "@clerk/backend/webhooks";
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

type ClerkUserPayload = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  image_url?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: Array<{ id: string; email_address: string }>;
};

function convexUserFieldsFromClerkUser(user: ClerkUserPayload) {
  const emails = user.email_addresses ?? [];
  const primaryId = user.primary_email_address_id;
  const primary =
    (primaryId ? emails.find((e) => e.id === primaryId) : undefined) ??
    emails[0];
  const email = primary?.email_address ?? `${user.id}@users.clerk`;

  const first = user.first_name?.trim() ?? "";
  const last = user.last_name?.trim() ?? "";
  let fullName = `${first} ${last}`.trim();
  if (!fullName) {
    fullName = user.username?.trim() || email;
  }

  const image = user.image_url?.trim();
  return {
    clerkUserId: user.id,
    email,
    fullName,
    profileImageUrl: image ? image : undefined,
  };
}

// ─── /chat ──────────────────────────────────────────────────────────────────

const handleChat = httpAction(async (ctx, request) => {
  // Optional: gate by auth
  // const identity = await ctx.auth.getUserIdentity();
  // if (!identity) return new Response("Unauthorized", { status: 401 });

  const body = await request.text();

  // --- Anthropic (commented out) ---
  // const response = await fetch("https://api.anthropic.com/v1/messages", {
  //   method: "POST",
  //   headers: {
  //     "x-api-key": process.env.ANTHROPIC_API_KEY!,
  //     "anthropic-version": "2023-06-01",
  //     "content-type": "application/json",
  //   },
  //   body,
  // });

  // --- Gemini Flash 3 ---
  const model = "gemini-2.0-flash";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${process.env.GOOGLE_GENERATIVE_AI_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[/chat] Gemini API error ${response.status}: ${errorBody}`);
    return new Response(errorBody, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }

  // Stream SSE back to the client unchanged
  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") || "text/event-stream",
      "cache-control": "no-cache",
    },
  });
});

http.route({
  path: "/chat",
  method: "POST",
  handler: handleChat,
});

// ─── /tts ───────────────────────────────────────────────────────────────────

const handleTTS = httpAction(async (ctx, request) => {
  // const identity = await ctx.auth.getUserIdentity();
  // if (!identity) return new Response("Unauthorized", { status: 401 });

  const body = await request.text();
  const voiceId = process.env.ELEVENLABS_VOICE_ID!;

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY!,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body,
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[/tts] ElevenLabs API error ${response.status}: ${errorBody}`);
    return new Response(errorBody, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") || "audio/mpeg",
    },
  });
});

http.route({
  path: "/tts",
  method: "POST",
  handler: handleTTS,
});

// ─── /transcribe-token ──────────────────────────────────────────────────────

const handleTranscribeToken = httpAction(async (ctx, request) => {
  // const identity = await ctx.auth.getUserIdentity();
  // if (!identity) return new Response("Unauthorized", { status: 401 });

  const response = await fetch(
    "https://streaming.assemblyai.com/v3/token?expires_in_seconds=480",
    {
      method: "GET",
      headers: {
        authorization: process.env.ASSEMBLYAI_API_KEY!,
      },
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[/transcribe-token] AssemblyAI token error ${response.status}: ${errorBody}`);
    return new Response(errorBody, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }

  const data = await response.text();
  return new Response(data, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

http.route({
  path: "/transcribe-token",
  method: "POST",
  handler: handleTranscribeToken,
});

// ─── /clerk/webhook/user (Clerk → Convex user sync) ─────────────────────────

const handleClerkUserWebhook = httpAction(async (ctx, request) => {
  const signingSecret = process.env.CLERK_WEBHOOK_SECRET;
  if (!signingSecret) {
    console.error("[clerk/webhook/user] Missing CLERK_WEBHOOK_SECRET");
    return new Response("Server misconfigured", { status: 500 });
  }

  let evt: Awaited<ReturnType<typeof verifyWebhook>>;
  try {
    evt = await verifyWebhook(request, { signingSecret });
  } catch (err) {
    console.error("[clerk/webhook/user] verifyWebhook failed:", err);
    return new Response("Invalid webhook", { status: 400 });
  }

  try {
    if (evt.type === "user.created" || evt.type === "user.updated") {
      const payload = convexUserFieldsFromClerkUser(
        evt.data as ClerkUserPayload,
      );
      await ctx.runMutation(internal.users.upsertFromClerkWebhook, payload);
    } else if (evt.type === "user.deleted") {
      const id = evt.data.id;
      if (!id) {
        console.error("[clerk/webhook/user] user.deleted missing id");
        return new Response("Bad payload", { status: 400 });
      }
      await ctx.runMutation(internal.users.deleteByClerkUserId, {
        clerkUserId: id,
      });
    }
  } catch (err) {
    console.error("[clerk/webhook/user] handler error:", err);
    return new Response("Webhook handler failed", { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

http.route({
  path: "/clerk/webhook/user",
  method: "POST",
  handler: handleClerkUserWebhook,
});

// Required: export the router as default
export default http;
