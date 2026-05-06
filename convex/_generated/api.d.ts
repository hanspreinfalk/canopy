/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as conversationTitleGeneration from "../conversationTitleGeneration.js";
import type * as conversations from "../conversations.js";
import type * as http from "../http.js";
import type * as routes_chat from "../routes/chat.js";
import type * as routes_clerk from "../routes/clerk.js";
import type * as routes_composio from "../routes/composio.js";
import type * as routes_screenshot from "../routes/screenshot.js";
import type * as routes_transcribe from "../routes/transcribe.js";
import type * as routes_tts from "../routes/tts.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  conversationTitleGeneration: typeof conversationTitleGeneration;
  conversations: typeof conversations;
  http: typeof http;
  "routes/chat": typeof routes_chat;
  "routes/clerk": typeof routes_clerk;
  "routes/composio": typeof routes_composio;
  "routes/screenshot": typeof routes_screenshot;
  "routes/transcribe": typeof routes_transcribe;
  "routes/tts": typeof routes_tts;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
