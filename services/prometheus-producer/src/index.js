import axios from "axios";
import Redis from "ioredis";

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: 6379,
  maxRetriesPerRequest: null
});

const PROM_URL = process.env.PROMETHEUS_URL;

async function fetchMetrics() {
  const res = await axios.get(`${PROM_URL}/api/v1/query`, {
    params: { query: "up" }
  });
  return res.data.data.result;
}

async function push(metrics) {
  for (const m of metrics) {
    const service = m.metric.instance || "prometheus";
    const value = parseFloat(m.value[1]);

    await redis.xadd(
      "metrics_stream",
      "*",
      "service_id", service,
      "metric_name", "up",
      "value", value.toString()
    );
  }
}

async function loop() {
  console.log("Prometheus producer started");

  while (true) {
    try {
      const metrics = await fetchMetrics();
      await push(metrics);
    } catch (err) {
      console.error("Producer error:", err.message);
    }

    await new Promise(r => setTimeout(r, 15000));
  }
}

loop();
