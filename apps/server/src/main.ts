import { createApp } from "./app";
import { loadConfig } from "./config";
const config = loadConfig();
const { app } = await createApp(config, process.env.SYNAPSE_DEV === "1");
await app.listen(config.server);
console.info("Synapse listening at", app.listeningOrigin);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void app.close();
  });
