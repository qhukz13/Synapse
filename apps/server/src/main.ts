import Fastify from "fastify";
import { loadConfig } from "./config";
const config = loadConfig();
const app = Fastify();
app.get("/api/health", async () => ({ ok: true }));
await app.listen(config.server);
console.info("Synapse API listening on loopback port", config.server.port);
