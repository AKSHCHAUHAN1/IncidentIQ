import Redis from "ioredis";

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: 6379,
  maxRetriesPerRequest: null
});

// FIX: MODE env var controls data pattern
// normal  = healthy metrics (for LSTM training)
// spike   = high metrics (for testing remediation pipeline)
// default = normal
const MODE = process.env.MODE || "normal";

function random(base, variance) {
  return base + (Math.random() - 0.5) * variance;
}

function getMetrics() {
  if (MODE === "spike") {
    // Always-critical values for testing remediation
    return {
      cpu:          95 + Math.random() * 3,
      memory:       92 + Math.random() * 3,
      request_rate: 1500 + Math.random() * 200,
      error_rate:   30 + Math.random() * 5,
      latency:      450 + Math.random() * 100,
    };
  }

  // Normal healthy values (good for LSTM training)
  return {
    cpu:          random(40, 20),
    memory:       random(60, 15),
    request_rate: random(500, 200),
    error_rate:   Math.max(0, random(5, 5)),
    latency:      random(120, 40),
  };
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
  console.log(`Synthetic generator started — MODE=${MODE}`);

  while (true) {
    try {
      const m = getMetrics();

      console.log({ mode: MODE, ...m });

      await pushMetric("service-a", "cpu",          m.cpu);
      await pushMetric("service-a", "memory",       m.memory);
      await pushMetric("service-a", "request_rate", m.request_rate);
      await pushMetric("service-a", "error_rate",   m.error_rate);
      await pushMetric("service-a", "latency",      m.latency);

    } catch (err) {
      console.error("Generator error:", err.message);
    }

    await new Promise(r => setTimeout(r, 5000));
  }
}

loop();