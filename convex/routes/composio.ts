import { httpRouter } from "convex/server";
import { httpAction } from "../_generated/server";

type HttpRouter = ReturnType<typeof httpRouter>;

const BASE = "https://backend.composio.dev";

function apiHeaders() {
  return {
    "x-api-key": process.env.COMPOSIO_API_KEY!,
    "Content-Type": "application/json",
  };
}

type ComposioAuthConfigError = {
  message?: string;
  code?: number;
  slug?: string;
  suggested_fix?: string;
};

/** Maps Composio auth_config create failures to a short message for the client alert. */
function formatAuthConfigCreateError(parsed: {
  error?: ComposioAuthConfigError;
  auth_config?: { id: string };
  id?: string;
}, rawBody: string): string {
  const err = parsed.error;
  if (
    err?.slug === "Auth_Config_DefaultAuthConfigNotFound" ||
    err?.code === 306
  ) {
    return (
      "This connector doesn’t support Composio’s built-in sign-in. " +
      "In the Composio dashboard, create an auth config for this toolkit with your own OAuth app (custom credentials), then try again or pick another connector."
    );
  }
  if (err?.message) {
    const parts = [err.message.trim()];
    if (err.suggested_fix?.trim()) {
      parts.push(err.suggested_fix.trim());
    }
    return parts.join(" ");
  }
  return rawBody.length > 400 ? `${rawBody.slice(0, 400)}…` : rawBody;
}

type ToolkitsPage = {
  items?: unknown[];
  next_cursor?: string | null;
  nextCursor?: string | null;
};

// GET /composio/apps — list available toolkits (apps)
const handleGetApps = httpAction(async (_ctx, _request) => {
  const items: unknown[] = [];
  let cursor: string | undefined;
  // Composio paginates with `cursor` / `next_cursor`; merge all pages for the client.
  const pageLimit = 1000;
  const maxPages = 500;

  for (let i = 0; i < maxPages; i++) {
    const url = new URL(`${BASE}/api/v3/toolkits`);
    url.searchParams.set("limit", String(pageLimit));
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetch(url.toString(), { headers: apiHeaders() });
    if (!response.ok) {
      const text = await response.text();
      console.error(`[composio/apps] ${response.status}:`, text.slice(0, 300));
      return new Response(JSON.stringify({ error: `Composio ${response.status}` }), {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    }

    const data = (await response.json()) as ToolkitsPage;
    if (Array.isArray(data.items) && data.items.length > 0) {
      items.push(...data.items);
    }

    const next = data.next_cursor ?? data.nextCursor ?? undefined;
    if (!next || next === cursor) {
      break;
    }
    cursor = next;
  }

  console.log(`[composio/apps] fetched ${items.length} toolkits`);
  return new Response(JSON.stringify({ items }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

// GET /composio/connections?userId=... — list connected accounts for a user
const handleGetConnections = httpAction(async (_ctx, request) => {
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId") ?? url.searchParams.get("entityId") ?? "";
  const response = await fetch(
    `${BASE}/api/v3/connected_accounts?user_ids=${encodeURIComponent(userId)}&limit=100`,
    { headers: apiHeaders() }
  );
  if (!response.ok) {
    const text = await response.text();
    console.error(`[composio/connections] ${response.status}:`, text.slice(0, 300));
    return new Response(JSON.stringify({ error: `Composio ${response.status}` }), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }
  const data = await response.json();
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

// POST /composio/connect
// Flow: find-or-create a Composio-managed auth_config for the toolkit,
//       then POST /connected_accounts/link → returns { redirect_url }
const handleConnect = httpAction(async (_ctx, request) => {
  const body = (await request.json()) as { userId: string; toolkitSlug: string };
  const { userId, toolkitSlug } = body;

  // 1. Look for an existing auth config for this toolkit
  let authConfigId: string | undefined;
  const listResp = await fetch(
    `${BASE}/api/v3.1/auth_configs?toolkit_slugs=${encodeURIComponent(toolkitSlug)}&limit=1`,
    { headers: apiHeaders() }
  );
  if (listResp.ok) {
    const listData = (await listResp.json()) as {
      items?: Array<{ auth_config: { id: string } }>;
    };
    authConfigId = listData.items?.[0]?.auth_config?.id;
  }

  // 2. If none exists, create a Composio-managed auth config (documented body shape).
  if (!authConfigId) {
    const createResp = await fetch(`${BASE}/api/v3.1/auth_configs`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        toolkit: { slug: toolkitSlug },
        auth_config: {
          type: "use_composio_managed_auth",
          credentials: {},
          restrict_to_following_tools: [],
        },
      }),
    });
    const createText = await createResp.text();
    let createData: unknown = {};
    try {
      createData = JSON.parse(createText) as object;
    } catch {
      createData = {};
    }
    const parsed = createData as {
      auth_config?: { id: string };
      id?: string;
      error?: ComposioAuthConfigError;
    };
    authConfigId = parsed.auth_config?.id ?? parsed.id;
    if (!authConfigId) {
      const friendly = formatAuthConfigCreateError(parsed, createText);
      console.error(
        `[composio/connect] no auth_config for ${toolkitSlug} (${createResp.status}):`,
        createText.slice(0, 600)
      );
      return new Response(JSON.stringify({ error: friendly }), {
        status: createResp.status >= 400 && createResp.status < 600 ? createResp.status : 502,
        headers: { "content-type": "application/json" },
      });
    }
  }

  // 3. Create the OAuth link
  const linkResp = await fetch(`${BASE}/api/v3/connected_accounts/link`, {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({ auth_config_id: authConfigId, user_id: userId }),
  });
  const linkRaw = await linkResp.text();
  console.log(`[composio/connect] ${toolkitSlug} → ${linkResp.status}:`, linkRaw.slice(0, 500));
  return new Response(linkRaw, {
    status: linkResp.status,
    headers: { "content-type": "application/json" },
  });
});

// POST /composio/disconnect — delete a connected account
const handleDisconnect = httpAction(async (_ctx, request) => {
  const body = (await request.json()) as { connectionId: string };
  const response = await fetch(
    `${BASE}/api/v3/connected_accounts/${body.connectionId}`,
    { method: "DELETE", headers: apiHeaders() }
  );
  const data = response.status === 204 ? { success: true } : await response.json();
  return new Response(JSON.stringify(data), {
    status: response.ok ? 200 : response.status,
    headers: { "content-type": "application/json" },
  });
});

export function registerComposioRoutes(http: HttpRouter) {
  http.route({ path: "/composio/apps", method: "GET", handler: handleGetApps });
  http.route({ path: "/composio/connections", method: "GET", handler: handleGetConnections });
  http.route({ path: "/composio/connect", method: "POST", handler: handleConnect });
  http.route({ path: "/composio/disconnect", method: "POST", handler: handleDisconnect });
}
