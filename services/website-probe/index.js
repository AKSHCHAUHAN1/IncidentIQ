/**
 * website-probe/index.js
 *
 * Probes registered URLs every 30 seconds and pushes real HTTP metrics
 * to the Redis stream so the existing ML pipeline can process them.
 *
 * Metrics collected per probe:
 *   response_time   ms  - full round-trip time
 *   ttfb            ms  - time to first byte
 *   status_code     int - HTTP status (200, 404, 500, etc.)
 *   availability    0/1 - 1 if reachable, 0 if timeout/error
 *   ssl_days        int - days until SSL cert expiry (HTTPS only)
 *   dns_ms          ms  - DNS resolution time
 *   redirect_count  int - number of redirects followed
 *   error_rate      %   - rolling 10-probe error percentage (maps to ML feature)
 *   latency         ms  - alias for response_time (ML feature name)
 */

import Redis    from "ioredis";
import https    from "https";
import http     from "http";
import dns      from "dns/promises";
import pkg      from "pg";
import { URL }  from "url";

const { Pool } = pkg;

const redis = new Redis({
  host: process.env.REDIS_HOST || "redis",
  port: 6379,
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

const pool = new Pool({
  host:     process.env.DB_HOST     || "postgres",
  port:     parseInt(process.env.DB_PORT || "5432"),
  user:     process.env.DB_USER     || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME     || "incident_predictor",
});

// Rolling error history per site: last 10 probes
const errorHistory = {};

// ── Probe a single URL ────────────────────────────────────────
async function probe(site) {
  const { id, url } = site;
  const parsed = new URL(url);
  const isHttps = parsed.protocol === "https:";

  const result = {
    service_id:     id,
    url,
    response_time:  null,
    ttfb:           null,
    status_code:    null,
    availability:   0,
    ssl_days:       null,
    dns_ms:         null,
    redirect_count: 0,
    error:          null,
  };

  try {
    // 1. DNS timing
    const dnsStart = Date.now();
    await dns.lookup(parsed.hostname);
    result.dns_ms = Date.now() - dnsStart;

    // 2. HTTP request with timing
    const requestStart = Date.now();
    await new Promise((resolve, reject) => {
      const lib = isHttps ? https : http;
      const req = lib.get(url, {
        timeout: 10000,
        headers: { "User-Agent": "IncidentIQ-Probe/1.0" },
      }, (res) => {
        result.ttfb        = Date.now() - requestStart;
        result.status_code = res.statusCode;
        result.redirect_count = (res.headers["location"] ? 1 : 0);

        // Consume response body (required to free socket)
        res.resume();
        res.on("end", () => {
          result.response_time = Date.now() - requestStart;
          result.availability  = res.statusCode < 500 ? 1 : 0;
          resolve();
        });
      });

      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      req.on("error",   reject);
    });

    // 3. SSL cert expiry (HTTPS only)
    if (isHttps) {
      await new Promise((resolve) => {
        const req = https.get(url, { headers: { "User-Agent": "IncidentIQ-Probe/1.0" } }, (res) => {
          const cert = res.socket?.getPeerCertificate?.();
          if (cert?.valid_to) {
            const expiry = new Date(cert.valid_to);
            result.ssl_days = Math.floor((expiry - Date.now()) / 86400000);
          }
          res.resume();
          res.on("end", resolve);
        });
        req.on("error", resolve); // Don't fail on cert error
      });
    }

  } catch (err) {
    result.error        = err.message;
    result.availability = 0;
    result.response_time = 10000; // Max out on failure
    result.ttfb          = 10000;
  }

  return result;
}

// ── Push metrics to Redis stream ──────────────────────────────
async function pushMetrics(probeResult) {
  const { service_id } = probeResult;

  // Track rolling error rate (last 10 probes)
  if (!errorHistory[service_id]) errorHistory[service_id] = [];
  const hist = errorHistory[service_id];
  hist.push(probeResult.availability === 0 || probeResult.status_code >= 400 ? 1 : 0);
  if (hist.length > 10) hist.shift();
  const error_rate = (hist.reduce((a, b) => a + b, 0) / hist.length) * 100;

  const metrics = {
    // ML pipeline feature names (must match FEATURES in config.py)
    cpu:          Math.min((probeResult.response_time / 100), 100),  // response_time → cpu proxy
    memory:       Math.min(((probeResult.ttfb || probeResult.response_time) / 100), 100),
    request_rate: probeResult.redirect_count * 10 + 500,  // synthetic baseline
    error_rate,
    latency:      probeResult.response_time || 10000,

    // Extra real metrics (stored but not fed to LSTM directly)
    response_time:  probeResult.response_time,
    status_code:    probeResult.status_code,
    availability:   probeResult.availability,
    ssl_days:       probeResult.ssl_days,
    dns_ms:         probeResult.dns_ms,
  };

  // Push each metric to Redis stream
  for (const [name, value] of Object.entries(metrics)) {
    if (value == null) continue;
    await redis.xadd("metrics_stream", "*",
      "service_id",  service_id,
      "metric_name", name,
      "value",       String(value)
    );
  }

  // Update last_probed + status in DB
  const status = probeResult.availability === 0 ? "down"
    : (probeResult.response_time > 3000 || error_rate > 20) ? "degraded"
    : "up";

  await pool.query(
    `UPDATE incidents.monitored_sites
     SET last_probed = NOW(), last_status = $1, last_response_ms = $2
     WHERE id = $3`,
    [status, probeResult.response_time, service_id]
  );

  console.log(`[probe] ${probeResult.url} | ${status} | ${probeResult.response_time}ms | err=${error_rate.toFixed(0)}% | ssl=${probeResult.ssl_days ?? "N/A"}d`);
}

// ── Load monitored sites from DB ──────────────────────────────
async function loadSites() {
  try {
    const r = await pool.query(
      "SELECT id, url, name FROM incidents.monitored_sites WHERE active = true"
    );
    return r.rows;
  } catch (err) {
    console.error("Failed to load sites:", err.message);
    return [];
  }
}

// ── Main probe loop ───────────────────────────────────────────
async function run() {
  await redis.connect();
  console.log("Website probe service started");

  while (true) {
    const sites = await loadSites();

    if (sites.length === 0) {
      console.log("[probe] No sites registered yet. Add a URL via the frontend.");
    } else {
      // Probe all sites in parallel
      const results = await Promise.allSettled(sites.map(probe));
      for (const r of results) {
        if (r.status === "fulfilled") {
          await pushMetrics(r.value).catch(console.error);
        } else {
          console.error("[probe] Failed:", r.reason?.message);
        }
      }
    }

    // Wait 30 seconds between probe rounds
    await new Promise(r => setTimeout(r, 30_000));
  }
}

run().catch(console.error);
