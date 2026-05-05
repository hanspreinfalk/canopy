import { httpRouter } from "convex/server";
import { registerChatRoutes } from "./routes/chat";
import { registerClerkRoutes } from "./routes/clerk";
import { registerTranscribeRoutes } from "./routes/transcribe";
import { registerTTSRoutes } from "./routes/tts";

const http = httpRouter();

registerChatRoutes(http);
registerTTSRoutes(http);
registerTranscribeRoutes(http);
registerClerkRoutes(http);

export default http;
