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
      "This toolkit doesn’t use Composio’s default managed auth (often API key or custom OAuth). " +
      "In the Composio dashboard, create an auth configuration for this toolkit (API key, bearer token, or OAuth with your own app), then try again."
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

/** Shape returned by GET /api/v3.1/auth_configs (flat `id`; older clients used nested `auth_config`). */
type ListedAuthConfig = {
  id?: string;
  auth_config?: { id: string };
  status?: string;
  is_composio_managed?: boolean;
};

function authConfigIdFromItem(item: ListedAuthConfig): string | undefined {
  return item.id ?? item.auth_config?.id;
}

/** Prefer dashboard (custom) configs over Composio-managed when both exist. */
function pickAuthConfigId(items: ListedAuthConfig[]): string | undefined {
  if (items.length === 0) return undefined;
  const usable = items.filter((i) => i.status !== "DISABLED");
  const pool = usable.length > 0 ? usable : items;
  const custom = pool.filter((i) => i.is_composio_managed === false);
  const chosen = custom.length > 0 ? custom[0] : pool[0];
  return authConfigIdFromItem(chosen);
}

async function listAuthConfigsForToolkit(toolkitSlug: string): Promise<ListedAuthConfig[]> {
  const all: ListedAuthConfig[] = [];
  let cursor: string | undefined;
  const maxPages = 100;

  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${BASE}/api/v3.1/auth_configs`);
    url.searchParams.set("toolkit_slug", toolkitSlug);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetch(url.toString(), { headers: apiHeaders() });
    if (!response.ok) {
      const text = await response.text();
      console.error(`[composio/auth_configs] ${response.status}:`, text.slice(0, 400));
      break;
    }
    const data = (await response.json()) as {
      items?: ListedAuthConfig[];
      next_cursor?: string | null;
    };
    if (Array.isArray(data.items)) {
      all.push(...data.items);
    }
    const next = data.next_cursor ?? undefined;
    if (!next || next === cursor) break;
    cursor = next;
  }
  return all;
}

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
// Flow: resolve auth_config (optional explicit id, list from Composio — correct `toolkit_slug` filter),
//       optionally create Composio-managed auth if nothing exists,
//       then POST /connected_accounts/link → { redirect_url } (with optional connection_data for API keys).
const handleConnect = httpAction(async (_ctx, request) => {
  const body = (await request.json()) as {
    userId: string;
    toolkitSlug: string;
    /** Use this auth config id when the client or ops pins a dashboard config. */
    authConfigId?: string;
    /** Passed through to Composio link (e.g. api_key, bearer_token, subdomain). */
    connectionData?: Record<string, unknown>;
  };
  const { userId, toolkitSlug, connectionData } = body;
  let authConfigId =
    typeof body.authConfigId === "string" && body.authConfigId.trim()
      ? body.authConfigId.trim()
      : undefined;

  // 1. List existing auth configs (GET uses `toolkit_slug`, not `toolkit_slugs`; items use top-level `id`).
  if (!authConfigId) {
    const listed = await listAuthConfigsForToolkit(toolkitSlug);
    authConfigId = pickAuthConfigId(listed);
    if (listed.length > 0 && !authConfigId) {
      console.warn(
        `[composio/connect] ${listed.length} auth_config(s) for ${toolkitSlug} but none had a usable id`
      );
    }
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

  // 3. Auth link session (OAuth redirect or hosted/API-key flow). Use v3.1 per API docs.
  const linkBody: Record<string, unknown> = {
    auth_config_id: authConfigId,
    user_id: userId,
  };
  if (connectionData && Object.keys(connectionData).length > 0) {
    linkBody.connection_data = connectionData;
  }

  const linkResp = await fetch(`${BASE}/api/v3.1/connected_accounts/link`, {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify(linkBody),
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
