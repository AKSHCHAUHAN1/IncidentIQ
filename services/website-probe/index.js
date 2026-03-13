/**
 * website-probe/index.js
 * ========================
 * HTTP probe service — polls all target URLs every 60 seconds
 * and writes real measurements to TimescaleDB.
 *
 * Measures:
 *   - TTFB (Time To First Byte)
 *   - DNS resolution time
 *   - TCP connect time
 *   - TLS handshake time
 *   - SSL certificate expiry (days left)
 *   - Rolling 5-minute error rate
 *   - HTTP status code
 *
 * All timing uses Node.js performance hooks — real measurements,
 * not estimates.
 */

import https from "https";
import http from "http";
import dns from "dns/promises";
import tls from "tls";
import { performance } from "perf_hooks";
import pg from "pg";
import Redis from "ioredis";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGETS_FILE = join(__dirname, "probe-targets.json");
const TARGETS = JSON.parse(readFileSync(TARGETS_FILE)).targets;

const PROBE_INTERVAL_MS = 60_000;           // probe every 60 seconds
const REQUEST_TIMEOUT_MS = 15_000;          // 15s timeout per request
const ERROR_RATE_WINDOW_MIN = 5;            // rolling window for error rate
const MAX_RETRIES = 1;                      // retry failed probes once

const DB_URL = process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/incidentiq";

const pool = new pg.Pool({ connectionString: DB_URL, max: 5 });

const REDIS_HOST = process.env.REDIS_HOST || "redis";
const redisClient = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null });
redisClient.on("connect", () => console.log("Redis connected"));
redisClient.on("error", (err) => console.error("Redis error:", err.message));

// ─────────────────────────────────────────────────────────────
// ROLLING ERROR RATE TRACKER
// Keeps last 5 minutes of status codes per URL in memory
// ─────────────────────────────────────────────────────────────

const errorWindows = new Map(); // url → [{ ts: Date, isError: boolean }]

function trackResult(url, isError) {
  if (!errorWindows.has(url)) errorWindows.set(url, []);
  const window = errorWindows.get(url);
  window.push({ ts: Date.now(), isError });

  // Prune entries older than 5 minutes
  const cutoff = Date.now() - ERROR_RATE_WINDOW_MIN * 60_000;
  const pruned = window.filter((e) => e.ts >= cutoff);
  errorWindows.set(url, pruned);

  const errors = pruned.filter((e) => e.isError).length;
  return errors / Math.max(pruned.length, 1);
}

// ─────────────────────────────────────────────────────────────
// SSL CERTIFICATE EXPIRY CHECK
// ─────────────────────────────────────────────────────────────

async function getSslDaysLeft(hostname) {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: hostname, port: 443, servername: hostname },
      () => {
        try {
          const cert = socket.getPeerCertificate();
          if (cert && cert.valid_to) {
            const expiryMs = new Date(cert.valid_to).getTime();
            const daysLeft = (expiryMs - Date.now()) / (1000 * 60 * 60 * 24);
            resolve(Math.max(0, daysLeft));
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        } finally {
          socket.destroy();
        }
      }
    );
    socket.on("error", () => resolve(null));
    socket.setTimeout(5000, () => { socket.destroy(); resolve(null); });
  });
}

// ─────────────────────────────────────────────────────────────
// CORE PROBE FUNCTION
// Returns real timing measurements for a single URL
// ─────────────────────────────────────────────────────────────

async function probe(targetUrl) {
  const url = new URL(targetUrl);
  const hostname = url.hostname;
  const isHttps = url.protocol === "https:";
  const lib = isHttps ? https : http;

  const result = {
    url: targetUrl,
    probed_at: new Date().toISOString(),
    ttfb_ms: null,
    dns_ms: null,
    tcp_ms: null,
    tls_ms: null,
    status_code: null,
    error_rate: null,
    ssl_days_left: null,
    response_size: null,
    content_type: null,
    error: null,
  };

  try {
    // DNS timing
    const dnsStart = performance.now();
    let resolvedIp;
    try {
      const addrs = await dns.resolve4(hostname);
      resolvedIp = addrs[0];
      result.dns_ms = Math.round(performance.now() - dnsStart);
    } catch (dnsErr) {
      result.dns_ms = Math.round(performance.now() - dnsStart);
      result.error = `DNS_FAIL: ${dnsErr.code}`;
      trackResult(targetUrl, true);
      return result;
    }

    // SSL days left (parallel, non-blocking on main timing)
    const sslPromise = isHttps ? getSslDaysLeft(hostname) : Promise.resolve(null);

    // HTTP request timing
    await new Promise((resolve, reject) => {
      const reqStart = performance.now();
      let tcpConnectedAt = null;
      let tlsConnectedAt = null;
      let firstByteAt = null;
      let totalBytes = 0;

      const req = lib.request(
        {
          hostname,
          path: url.pathname + url.search,
          port: isHttps ? 443 : 80,
          method: "GET",
          headers: {
            "User-Agent": "IncidentIQ-Probe/1.0 (performance monitoring)",
            Accept: "*/*",
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          firstByteAt = performance.now();
          result.ttfb_ms = Math.round(firstByteAt - reqStart);
          result.status_code = res.statusCode;
          result.content_type = res.headers["content-type"] || null;

          res.on("data", (chunk) => {
            totalBytes += chunk.length;
          });

          res.on("end", () => {
            result.response_size = totalBytes;
            resolve();
          });

          res.on("error", reject);
        }
      );

      req.on("socket", (socket) => {
        socket.on("connect", () => {
          tcpConnectedAt = performance.now();
          result.tcp_ms = Math.round(tcpConnectedAt - reqStart - (result.dns_ms || 0));
        });
        socket.on("secureConnect", () => {
          tlsConnectedAt = performance.now();
          result.tls_ms = Math.round(tlsConnectedAt - (tcpConnectedAt || reqStart));
        });
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new Error("REQUEST_TIMEOUT"));
      });

      req.on("error", reject);
      req.end();
    });

    // SSL cert expiry (wait for parallel check)
    result.ssl_days_left = await sslPromise;

    // Rolling error rate
    const isError = !result.status_code || result.status_code >= 400;
    result.error_rate = trackResult(targetUrl, isError);

  } catch (err) {
    result.error = err.message;
    result.error_rate = trackResult(targetUrl, true);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// WRITE TO TIMESCALEDB
// ─────────────────────────────────────────────────────────────

const INSERT_SQL = `
  INSERT INTO metrics.probe_readings (
    url, probed_at, ttfb_ms, dns_ms, tcp_ms, tls_ms,
    status_code, error_rate, ssl_days_left, response_size, content_type
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
`;

async function publishToRedis(reading) {
  try {
    const sampleTs = reading.probed_at;
    const serviceId = new URL(reading.url).hostname;
    const metrics = {
      ttfb_ms:       reading.ttfb_ms ?? 0,
      dns_ms:        reading.dns_ms ?? 0,
      error_rate:    reading.error_rate ?? 0,
      ssl_days_left: reading.ssl_days_left ?? 365,
      status_code:   reading.status_code ?? 0,
      tcp_ms:        reading.tcp_ms ?? 0,
      tls_ms:        reading.tls_ms ?? 0,
    };
    for (const [metricName, value] of Object.entries(metrics)) {
      await redisClient.xadd(
        "metrics_stream", "*",
        "service_id", serviceId,
        "metric_name", metricName,
        "value", String(value),
        "sample_ts", sampleTs,
        "url", reading.url
      );
    }
  } catch (err) {
    console.error(`[REDIS ERROR] ${reading.url}: ${err.message}`);
  }
}

async function writeReading(reading) {
  try {
    await pool.query(INSERT_SQL, [
      reading.url,
      reading.probed_at,
      reading.ttfb_ms,
      reading.dns_ms,
      reading.tcp_ms,
      reading.tls_ms,
      reading.status_code,
      reading.error_rate,
      reading.ssl_days_left,
      reading.response_size,
      reading.content_type,
    ]);
    // Publish to Redis stream for the inference pipeline
    await publishToRedis(reading);
  } catch (err) {
    console.error(`[DB ERROR] ${reading.url}: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// PROBE LOOP
// ─────────────────────────────────────────────────────────────

async function probeAll() {
  const start = Date.now();
  console.log(`[${new Date().toISOString()}] Probing ${TARGETS.length} URLs...`);

  const results = await Promise.allSettled(
    TARGETS.map(async (target) => {
      const reading = await probe(target.probe_url);

      // Log summary
      const status = reading.error
        ? `ERROR: ${reading.error}`
        : `${reading.status_code} | TTFB: ${reading.ttfb_ms}ms | DNS: ${reading.dns_ms}ms | SSL: ${reading.ssl_days_left?.toFixed(0)}d`;
      console.log(`  ${target.name.padEnd(15)} ${status}`);

      await writeReading(reading);
      return reading;
    })
  );

  const elapsed = Date.now() - start;
  const ok = results.filter((r) => r.status === "fulfilled" && !r.value.error).length;
  const errors = TARGETS.length - ok;

  console.log(`  Done in ${elapsed}ms | OK: ${ok} | Errors: ${errors}\n`);
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────

console.log("IncidentIQ Website Probe starting...");
console.log(`Targets: ${TARGETS.length} URLs | Interval: ${PROBE_INTERVAL_MS / 1000}s`);

// First probe immediately on startup
probeAll().catch(console.error);

// Then probe every 60 seconds
setInterval(() => probeAll().catch(console.error), PROBE_INTERVAL_MS);

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  await pool.end();
  process.exit(0);
});