/**
 * chaos-server.js — Complete anomaly simulation server for IncidentIQ
 *
 * Simulates every anomaly type the ML pipeline is trained to detect:
 *   origin_slowdown     → TTFB high, DNS normal
 *   dns-slow            → DNS-pattern delay (TTFB high, origin fraction low)
 *   error               → 500 status codes
 *   ssl-expiry          → points to https://expired.badssl.com/ for real SSL test
 *   latency-spike       → sudden TTFB jump, both DNS and origin elevated
 *   ramp                → TTFB climbs slowly over time (primary LSTM test)
 *   flapping            → alternates origin-slow/normal every 4 requests
 *
 * Usage:
 *   node scripts/chaos-server.js
 *
 * Add in Monitor page: http://host.docker.internal:4444/
 *
 * Controls:
 *   curl http://localhost:4444/set/normal
 *   curl http://localhost:4444/set/origin-slow
 *   curl http://localhost:4444/set/dns-slow
 *   curl http://localhost:4444/set/error
 *   curl http://localhost:4444/set/latency-spike
 *   curl http://localhost:4444/set/ramp
 *   curl http://localhost:4444/set/flapping
 *   curl http://localhost:4444/reset-ramp
 *   curl http://localhost:4444/status
 */

const http = require("http");

let mode         = "normal";
let requestCount = 0;
let rampStart    = null;
let rampMs       = 80;

const RAMP_MAX_MS       = 4000;
const RAMP_STEP_PER_REQ = 80;
const NORMAL_BASE_MS    = 80;
const SLA_THRESHOLD_MS  = 2000;

function respond(res, statusCode, body, extraHeaders = {}) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders,
  };
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(body));
}

const modeDescriptions = {
  "normal":        `Healthy baseline (~${NORMAL_BASE_MS}ms TTFB)`,
  "origin-slow":   "Origin slowdown — 2.2-3s TTFB above 2000ms SLA — expect origin_slowdown",
  "dns-slow":      "DNS-pattern delay — 500-800ms total — may classify as latency_spike",
  "error":         "500 errors instantly — expect error_spike classification",
  "latency-spike": "Sudden 1.8-2.8s spike — expect latency_spike classification",
  "ramp":          `Gradual TTFB ramp from ${NORMAL_BASE_MS}ms to ${RAMP_MAX_MS}ms — primary LSTM test`,
  "flapping":      "Alternates origin-slow/normal every 4 requests",
};

const server = http.createServer((req, res) => {

  // ── Mode control endpoints ─────────────────────────────────
  const modeMap = {
    "/set/normal":        "normal",
    "/set/origin-slow":   "origin-slow",
    "/set/dns-slow":      "dns-slow",
    "/set/error":         "error",
    "/set/latency-spike": "latency-spike",
    "/set/ramp":          "ramp",
    "/set/flapping":      "flapping",
  };

  if (modeMap[req.url] !== undefined) {
    const prev = mode;
    mode = modeMap[req.url];
    if (mode === "ramp") { rampMs = NORMAL_BASE_MS; rampStart = Date.now(); }
    console.log(`[mode] ${prev} → ${mode}`);
    return respond(res, 200, { mode, msg: modeDescriptions[mode] });
  }

  if (req.url === "/reset-ramp") {
    rampMs = NORMAL_BASE_MS; rampStart = Date.now();
    return respond(res, 200, { mode, ramp_ms: rampMs, msg: "Ramp reset" });
  }

  if (req.url === "/status") {
    return respond(res, 200, {
      mode, requestCount,
      ramp_ms:           mode === "ramp" ? Math.round(rampMs) : null,
      ramp_elapsed_sec:  mode === "ramp" && rampStart ? Math.round((Date.now() - rampStart) / 1000) : null,
      sla_threshold_ms:  SLA_THRESHOLD_MS,
      sla_breached:      mode === "ramp" ? rampMs >= SLA_THRESHOLD_MS : null,
    });
  }

  // ── Probe responses ───────────────────────────────────────
  requestCount++;
  const effective = mode === "flapping"
    ? (requestCount % 4 === 0 ? "origin-slow" : "normal")
    : mode;

  switch (effective) {

    case "normal": {
      const d = NORMAL_BASE_MS + Math.random() * 50;
      setTimeout(() => respond(res, 200, { status: "ok", mode: "normal", ttfb_hint_ms: Math.round(d) }), d);
      break;
    }

    // Origin server slow — clearly above 2000ms SLA
    // Token signature: ttfb_very_slow dns_fast ratio_origin_dominant errors_clean
    // Expected ML label: origin_slowdown
    case "origin-slow": {
      const d = 2200 + Math.random() * 800;
      setTimeout(() => respond(res, 200, {
        status: "ok", mode: "origin-slow",
        ttfb_hint_ms: Math.round(d),
        msg: "DNS healthy, server processing slow",
      }), d);
      break;
    }

    // DNS pattern delay — total TTFB is elevated but origin fraction is low
    // Token signature: ttfb_slow dns_slow ratio_dns_dominant errors_clean
    // Expected ML label: latency_spike or dns_degradation depending on z-scores
    case "dns-slow": {
      const dns    = 400 + Math.random() * 200;
      const origin = 100 + Math.random() * 50;
      const total  = dns + origin;
      setTimeout(() => respond(res, 200, {
        status: "ok", mode: "dns-slow",
        ttfb_hint_ms: Math.round(total),
        msg: "DNS resolution delayed, origin fast",
      }), total);
      break;
    }

    // Error spike — instant 500, no delay
    // Token signature: errors_critical status_server_error
    // Expected ML label: error_spike
    case "error": {
      respond(res, 500, {
        status: "error", mode: "error",
        msg: "Simulated internal server error",
      });
      break;
    }

    // Latency spike — sudden jump, both DNS and origin appear slow
    // Token signature: ttfb_slow dns_moderate ratio_balanced errors_clean
    // Expected ML label: latency_spike
    case "latency-spike": {
      const d = 1800 + Math.random() * 1000;
      setTimeout(() => respond(res, 200, {
        status: "ok", mode: "latency-spike",
        ttfb_hint_ms: Math.round(d),
        msg: "CDN or routing issue pattern",
      }), d);
      break;
    }

    // Gradual ramp — TTFB increases 80ms per probe cycle
    // This is the primary LSTM test — LSTM should forecast the rising trend
    // and predict SLA breach BEFORE rampMs actually hits 2000ms
    case "ramp": {
      rampMs = Math.min(RAMP_MAX_MS, rampMs + RAMP_STEP_PER_REQ);
      const jitter     = (Math.random() - 0.5) * 40;
      const delay      = Math.max(50, rampMs + jitter);
      const breachIn   = rampMs < SLA_THRESHOLD_MS
        ? Math.round((SLA_THRESHOLD_MS - rampMs) / RAMP_STEP_PER_REQ)
        : 0;

      console.log(`[ramp] ${Math.round(delay)}ms | breach in ~${breachIn} more cycles`);

      setTimeout(() => respond(res, 200, {
        status: "ok", mode: "ramp",
        current_ttfb_ms:    Math.round(delay),
        sla_threshold_ms:   SLA_THRESHOLD_MS,
        breach_in_cycles:   breachIn,
        msg: breachIn === 0 ? "SLA BREACHED" : `Breach in ~${breachIn} more probe cycles`,
      }), delay);
      break;
    }

    default: {
      respond(res, 200, { status: "ok", mode });
    }
  }
});

const PORT = 4444;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🔥  IncidentIQ Chaos Server  →  http://0.0.0.0:${PORT}`);
  console.log(`\nAdd in Monitor page: http://host.docker.internal:${PORT}/\n`);
  console.log("─".repeat(65));
  Object.entries(modeDescriptions).forEach(([m, desc]) => {
    console.log(`  curl http://localhost:${PORT}/set/${m}`);
    console.log(`       → ${desc}\n`);
  });
  console.log(`  curl http://localhost:${PORT}/status`);
  console.log(`  curl http://localhost:${PORT}/reset-ramp`);
  console.log("─".repeat(65) + "\n");
});
