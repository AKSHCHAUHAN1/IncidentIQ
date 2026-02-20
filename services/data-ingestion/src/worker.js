import { redis } from "./redis.js";
import { pool } from "./postgres.js";
import { writeToVictoria } from "./victoria.js";

let running = true;

export async function startWorker() {
  console.log("Starting ingestion worker...");

  await redis.xgroup("CREATE", "metrics_stream", "group1", "$", "MKSTREAM")
    .catch(() => {});

  while (running) {
    try {
      const response = await redis.xreadgroup(
        "GROUP", "group1", "consumer1",
        "BLOCK", 5000,
        "COUNT", 10,
        "STREAMS", "metrics_stream", ">"
      );

      if (!response) continue;

      const [, messages] = response[0];

      for (const [id, fields] of messages) {
        const metric = {
          time: new Date(),
          service_id: fields[1],
          metric_name: fields[3],
          value: parseFloat(fields[5])
        };

        await pool.query(
          `INSERT INTO metrics.raw_metrics(time, service_id, metric_name, value)
           VALUES($1,$2,$3,$4)`,
          [metric.time, metric.service_id, metric.metric_name, metric.value]
        );

        await writeToVictoria(metric);

        await redis.xack("metrics_stream", "group1", id);
      }
    } catch (err) {
      console.error("Worker error:", err.message);
    }
  }
}

export function stopWorker() {
  running = false;
}
