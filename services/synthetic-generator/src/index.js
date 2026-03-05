import Redis from "ioredis";

const redis = new Redis({
  host: process.env.REDIS_HOST || "redis",
  port: 6379,
  maxRetriesPerRequest: null,
});

// MODE controls what data pattern is generated:
//   normal  → healthy baseline (good for training)
//   spike   → sustained critical values (test remediation)
//   ramp    → gradual degradation → failure → recovery (best for LSTM training)
//   mixed   → cycles through all patterns (production-like, recommended)
const MODE = process.env.MODE || "mixed";

// ── Pattern generators ────────────────────────────────────────

function normalMetrics(t) {
  return {
    cpu:          40  + Math.sin(t * 0.1) * 8  + (Math.random() - 0.5) * 5,
    memory:       60  + Math.sin(t * 0.05) * 5 + (Math.random() - 0.5) * 3,
    request_rate: 500 + Math.sin(t * 0.08) * 80 + (Math.random() - 0.5) * 40,
    error_rate:   3   + Math.random() * 3,
    latency:      120 + Math.random() * 30,
  };
}

function spikeMetrics() {
  return {
    cpu:          94 + Math.random() * 4,
    memory:       91 + Math.random() * 4,
    request_rate: 1500 + Math.random() * 200,
    error_rate:   28 + Math.random() * 7,
    latency:      480 + Math.random() * 120,
  };
}

// Ramp: gradual degradation over ~60 steps → peak → recovery
// This teaches the LSTM what a failure looks like before it happens
let rampStep = 0;
const RAMP_TOTAL = 80;
function rampMetrics() {
  rampStep = (rampStep + 1) % RAMP_TOTAL;
  const phase = rampStep / RAMP_TOTAL;

  if (phase < 0.5) {
    // Gradual degradation (first 50%)
    const t = phase / 0.5;
    return {
      cpu:          40  + t * 55  + (Math.random() - 0.5) * 3,
      memory:       60  + t * 35  + (Math.random() - 0.5) * 2,
      request_rate: 500 + t * 1000 + (Math.random() - 0.5) * 50,
      error_rate:   3   + t * 28  + Math.random() * 2,
      latency:      120 + t * 380 + Math.random() * 20,
    };
  } else if (phase < 0.65) {
    // Peak failure zone
    return spikeMetrics();
  } else {
    // Recovery (last 35%)
    const t = (phase - 0.65) / 0.35;
    return {
      cpu:          95  - t * 55  + (Math.random() - 0.5) * 3,
      memory:       92  - t * 32  + (Math.random() - 0.5) * 2,
      request_rate: 1500 - t * 1000 + (Math.random() - 0.5) * 50,
      error_rate:   35  - t * 32  + Math.random() * 2,
      latency:      480 - t * 360 + Math.random() * 20,
    };
  }
}

// Mixed: alternates between normal (70%) and ramp (30%) so the
// training data reflects real production patterns
let tick = 0;
function mixedMetrics() {
  tick++;
  // Every 120 ticks (~10 min), run a full degradation ramp
  const inRampWindow = (tick % 120) < 36; // 36 ticks = 30% of the time
  return inRampWindow ? rampMetrics() : normalMetrics(tick);
}

// ── Clamp to realistic bounds ─────────────────────────────────
function clamp(metrics) {
  return {
    cpu:          Math.max(0, Math.min(100, metrics.cpu)),
    memory:       Math.max(0, Math.min(100, metrics.memory)),
    request_rate: Math.max(0, metrics.request_rate),
    error_rate:   Math.max(0, Math.min(100, metrics.error_rate)),
    latency:      Math.max(1, metrics.latency),
  };
}

// ── Push one metric to Redis stream ──────────────────────────
async function push(service, name, value) {
  await redis.xadd("metrics_stream", "*",
    "service_id",   service,
    "metric_name",  name,
    "value",        value.toString()
  );
}

// ── Main loop ─────────────────────────────────────────────────
async function loop() {
  console.log(`Synthetic generator started — MODE=${MODE}`);

  let t = 0;
  while (true) {
    try {
      let m;
      switch (MODE) {
        case "spike":  m = spikeMetrics();      break;
        case "ramp":   m = rampMetrics();        break;
        case "mixed":  m = mixedMetrics();       break;
        default:       m = normalMetrics(t);     break;
      }

      m = clamp(m);

      if (t % 12 === 0) {  // log every ~60 seconds
        console.log(`[${MODE}] cpu=${m.cpu.toFixed(1)}% mem=${m.memory.toFixed(1)}% err=${m.error_rate.toFixed(1)}% lat=${m.latency.toFixed(0)}ms`);
      }

      await push("service-a", "cpu",          m.cpu);
      await push("service-a", "memory",       m.memory);
      await push("service-a", "request_rate", m.request_rate);
      await push("service-a", "error_rate",   m.error_rate);
      await push("service-a", "latency",      m.latency);

    } catch (err) {
      console.error("Generator error:", err.message);
    }

    t++;
    await new Promise(r => setTimeout(r, 5000));
  }
}

loop();