import Fastify from "fastify";
import cors from "@fastify/cors";
import { env } from "./env.js";
import { registerJWT } from "./auth.js";
import { authRoutes } from "./routes/auth.js";
import { chatRoutes } from "./routes/chat.js";
import { conversationRoutes } from "./routes/conversations.js";
import { hotelRoutes } from "./routes/hotels.js";
import { promptRoutes } from "./routes/prompts.js";
import { settingsRoutes } from "./routes/settings.js";
import { credentialRoutes } from "./routes/credentials.js";
import { feedbackRoutes } from "./routes/feedback.js";
import { suggestionsRoutes } from "./routes/suggestions.js";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true }); // allow all in dev
await registerJWT(app);

app.get("/health", async () => ({ ok: true }));

await authRoutes(app);
await hotelRoutes(app);
await conversationRoutes(app);
await chatRoutes(app);
await promptRoutes(app);
await settingsRoutes(app);
await credentialRoutes(app);
await feedbackRoutes(app);
await suggestionsRoutes(app);

const port = Number(env.PORT || 3000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
