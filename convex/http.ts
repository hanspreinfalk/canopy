import { httpRouter } from "convex/server";
import { registerChatRoutes } from "./routes/chat";
import { registerClerkRoutes } from "./routes/clerk";
import { registerComposioRoutes } from "./routes/composio";
import { registerScreenshotRoutes } from "./routes/screenshot";
import { registerTranscribeRoutes } from "./routes/transcribe";
import { registerTTSRoutes } from "./routes/tts";

const http = httpRouter();

registerChatRoutes(http);
registerComposioRoutes(http);
registerTTSRoutes(http);
registerTranscribeRoutes(http);
registerClerkRoutes(http);
registerScreenshotRoutes(http);

export default http;
