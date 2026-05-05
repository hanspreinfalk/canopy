import { httpRouter } from "convex/server";
import { httpAction } from "../_generated/server";

type HttpRouter = ReturnType<typeof httpRouter>;

const handleTTS = httpAction(async (_ctx, request) => {
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
    console.error(`[/tts] ElevenLabs error ${response.status}: ${errorBody}`);
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

export function registerTTSRoutes(http: HttpRouter) {
  http.route({ path: "/tts", method: "POST", handler: handleTTS });
}
