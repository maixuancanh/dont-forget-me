import { config } from "./config.js";
import { createApp } from "./app.js";
const c = config();
const { app } = await createApp(c);
await app.listen({ port: c.PORT, host: c.HOST });
console.log(
  `DON'T FORGET ME service on ${c.HOST}:${c.PORT} (${c.MEMORY_MODE})`,
);
const timer = setInterval(() => {}, 60000);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    clearInterval(timer);
    await app.close();
    process.exit(0);
  });
