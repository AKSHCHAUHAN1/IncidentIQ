import { startWorker, stopWorker } from "./worker.js";
import { startServer } from "./server.js";

async function bootstrap() {
  const server = startServer();
  startWorker();

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  async function shutdown() {
    console.log("Shutting down...");
    stopWorker();
    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });
  }
}

bootstrap();
