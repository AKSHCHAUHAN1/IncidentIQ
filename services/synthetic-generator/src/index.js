import Redis from "ioredis";

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: 6379,
  maxRetriesPerRequest: null
});

function random(base, variance) {
  return base + (Math.random() - 0.5) * variance;
}

async function pushMetric(service, name, value) {
  await redis.xadd(
    "metrics_stream",
    "*",
    "service_id", service,
    "metric_name", name,
    "value", value.toString()
  );
}

async function loop() {
  console.log("Synthetic generator (5 features) started");

  while (true) {
    try {
      const cpu = random(40, 20);
      const memory = random(60, 15);
      const request_rate = random(500, 200);
      const error_rate = Math.max(0, random(5, 5));
      const latency = random(120, 40);

      await pushMetric("service-a", "cpu", cpu);
      await pushMetric("service-a", "memory", memory);
      await pushMetric("service-a", "request_rate", request_rate);
      await pushMetric("service-a", "error_rate", error_rate);
      await pushMetric("service-a", "latency", latency);

    } catch (err) {
      console.error("Generator error:", err.message);
    }

    await new Promise(r => setTimeout(r, 5000));
  }
}

loop();
