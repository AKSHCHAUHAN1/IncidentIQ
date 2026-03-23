/**
 * chaos-server.js — A tiny test server that simulates anomalies for IncidentIQ.
 *
 * Usage:
 *   node scripts/chaos-server.js                    # starts in "normal" mode
 *   curl http://localhost:4444/set/slow             # switch to slow mode (1.5s–3s delay)
 *   curl http://localhost:4444/set/very-slow        # switch to very slow mode (3s–6s delay → triggers SLA breach)
 *   curl http://localhost:4444/set/error            # switch to 500 error mode
 *   curl http://localhost:4444/set/normal           # back to normal
 *   curl http://localhost:4444/set/flapping         # alternates between slow and normal
 *   curl http://localhost:4444/status               # see current mode
 *
 * Then add http://host.docker.internal:4444/ as a monitored site in your frontend.
 * (host.docker.internal lets Docker containers reach your Mac's localhost)
 *
 * The website-probe will start probing it every 60s, and you'll see predictions
 * appear once enough data flows through the pipeline.
 *
 * QUICK TEST PLAN:
 *   1. Start this server: node scripts/chaos-server.js
 *   2. In the frontend Monitor page, add: http://host.docker.internal:4444/
 *   3. Wait 2-3 minutes (probe needs a few readings)
 *   4. Switch to slow mode: curl http://localhost:4444/set/slow
 *   5. Watch the Monitor page — site should show "degraded" within 60s
 *   6. Switch to very-slow: curl http://localhost:4444/set/very-slow
 *   7. Site should show "down" and predictions should appear on the Predictions page
 *   8. Switch to error: curl http://localhost:4444/set/error
 *   9. Error spike should be detected
 */

const http = require("http");

let mode = "normal";
let requestCount = 0;

const server = http.createServer((req, res) => {
  // Control endpoints (not probed — these are for you to switch modes)
  if (req.url === "/set/normal")     { mode = "normal";    return respond(res, 200, { mode, msg: "Now healthy" }); }
  if (req.url === "/set/slow")       { mode = "slow";      return respond(res, 200, { mode, msg: "Now slow (1.5-3s TTFB)" }); }
  if (req.url === "/set/very-slow")  { mode = "very-slow"; return respond(res, 200, { mode, msg: "Now very slow (3-6s TTFB → SLA breach)" }); }
  if (req.url === "/set/error")      { mode = "error";     return respond(res, 200, { mode, msg: "Now returning 500 errors" }); }
  if (req.url === "/set/flapping")   { mode = "flapping";  return respond(res, 200, { mode, msg: "Now flapping (alternating slow/normal)" }); }
  if (req.url === "/status")         { return respond(res, 200, { mode, requestCount }); }

  // Main endpoint — this is what the probe hits
  requestCount++;
  const currentMode = mode === "flapping" ? (requestCount % 3 === 0 ? "slow" : "normal") : mode;

  switch (currentMode) {
    case "slow":
      // 1.5–3s delay → triggers "degraded" status (ttfb >= 1000ms)
      const slowDelay = 1500 + Math.random() * 1500;
      setTimeout(() => respond(res, 200, { status: "ok", mode: "slow", delay_ms: Math.round(slowDelay) }), slowDelay);
      break;

    case "very-slow":
      // 3–6s delay → triggers "down" status (ttfb >= 2000ms) and SLA breach predictions
      const verySlowDelay = 3000 + Math.random() * 3000;
      setTimeout(() => respond(res, 200, { status: "ok", mode: "very-slow", delay_ms: Math.round(verySlowDelay) }), verySlowDelay);
      break;

    case "error":
      // 500 error → triggers "error_spike" root cause
      respond(res, 500, { status: "error", msg: "Internal Server Error (simulated)" });
      break;

    default:
      // Normal — fast response
      const normalDelay = 50 + Math.random() * 100;
      setTimeout(() => respond(res, 200, { status: "ok", mode: "normal" }), normalDelay);
  }
});

function respond(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const PORT = 4444;
server.listen(PORT, () => {
  console.log(`\n🔥 Chaos Test Server running on http://localhost:${PORT}`);
  console.log(`\nAdd this URL in your frontend Monitor page:`);
  console.log(`  http://host.docker.internal:${PORT}/\n`);
  console.log(`Control commands:`);
  console.log(`  curl http://localhost:${PORT}/set/normal      → healthy`);
  console.log(`  curl http://localhost:${PORT}/set/slow         → 1.5-3s delay (degraded)`);
  console.log(`  curl http://localhost:${PORT}/set/very-slow    → 3-6s delay (SLA breach/down)`);
  console.log(`  curl http://localhost:${PORT}/set/error        → 500 errors`);
  console.log(`  curl http://localhost:${PORT}/set/flapping     → alternating`);
  console.log(`  curl http://localhost:${PORT}/status           → check current mode\n`);
});
