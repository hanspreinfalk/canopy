import { verifyWebhook } from "@clerk/backend/webhooks";
import { httpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";

type HttpRouter = ReturnType<typeof httpRouter>;

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
      const payload = convexUserFieldsFromClerkUser(evt.data as ClerkUserPayload);
      await ctx.runMutation(internal.users.upsertFromClerkWebhook, payload);
    } else if (evt.type === "user.deleted") {
      const id = evt.data.id;
      if (!id) {
        console.error("[clerk/webhook/user] user.deleted missing id");
        return new Response("Bad payload", { status: 400 });
      }
      await ctx.runMutation(internal.users.deleteByClerkUserId, { clerkUserId: id });
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

export function registerClerkRoutes(http: HttpRouter) {
  http.route({ path: "/clerk/webhook/user", method: "POST", handler: handleClerkUserWebhook });
}
