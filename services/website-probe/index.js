/**
 * website-probe/index.js
 * ========================
 * HTTP probe service — polls all target URLs every 30 seconds
 * and writes real measurements to TimescaleDB.
 *
 * On startup: seeds training URLs from probe-targets.json into
 * public.monitored_sites with is_training_only = TRUE.
 *
 * Every cycle: queries public.monitored_sites for active targets,
 * merges into in-memory list, and probes all of them.
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGETS_FILE = join(__dirname, "probe-targets.json");
const SEED_TARGETS = JSON.parse(readFileSync(TARGETS_FILE)).targets;

const PROBE_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const ERROR_RATE_WINDOW_MIN = 5;

const DB_URL = process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/incident_predictor";

const pool = new pg.Pool({ connectionString: DB_URL, max: 5 });

const REDIS_HOST = process.env.REDIS_HOST || "redis";
const redisClient = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null });
redisClient.on("connect", () => console.log("Redis connected"));
redisClient.on("error", (err) => console.error("Redis error:", err.message));

// ── In-memory targets list (refreshed from DB each cycle) ─────
let activeTargets = [];
const errorWindows = new Map();

// ── Seed training URLs into public.monitored_sites ────────────
async function seedTrainingUrls() {
  console.log(`[SEED] Seeding ${SEED_TARGETS.length} training URLs into public.monitored_sites...`);
  for (const target of SEED_TARGETS) {
    try {
      await pool.query(
        `INSERT INTO public.monitored_sites (url, name, is_training_only, is_active)
         VALUES ($1, $2, TRUE, TRUE)
         ON CONFLICT (url) DO NOTHING`,
        [target.probe_url, target.name]
      );
    } catch (err) {
      console.error(`[SEED ERROR] ${target.name}: ${err.message}`);
    }
  }
  console.log(`[SEED] Done seeding training URLs.`);
}

// ── Refresh targets from DB ────────────────────────────────────
async function refreshTargetsFromDB() {
  try {
    const result = await pool.query(
      `SELECT id, url, name, is_training_only
       FROM public.monitored_sites
       WHERE is_active = TRUE`
    );
    activeTargets = result.rows.map(row => ({
      id: row.id,
      probe_url: row.url,
      name: row.name || new URL(row.url).hostname,
      is_training_only: row.is_training_only,
    }));
    console.log(`[TARGETS] Refreshed: ${activeTargets.length} active targets (${activeTargets.filter(t => !t.is_training_only).length} user, ${activeTargets.filter(t => t.is_training_only).length} training)`);
  } catch (err) {
    console.error(`[TARGETS ERROR] Failed to refresh from DB: ${err.message}`);
    // If DB fails and we have no targets, fall back to seed targets
    if (activeTargets.length === 0) {
      activeTargets = SEED_TARGETS.map(t => ({
        probe_url: t.probe_url,
        name: t.name,
        is_training_only: true,
      }));
      console.log(`[TARGETS] Falling back to ${activeTargets.length} seed targets`);
    }
  }
}

function trackResult(url, isError) {
  if (!errorWindows.has(url)) errorWindows.set(url, []);
  const window = errorWindows.get(url);
  window.push({ ts: Date.now(), isError });

  const cutoff = Date.now() - ERROR_RATE_WINDOW_MIN * 60_000;
  const pruned = window.filter((e) => e.ts >= cutoff);
  errorWindows.set(url, pruned);

  const errors = pruned.filter((e) => e.isError).length;
  return errors / Math.max(pruned.length, 1);
}

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
    const dnsStart = performance.now();
    let resolvedIp;
    try {
      const addrs = await dns.resolve4(hostname);
      resolvedIp = addrs[0];
      result.dns_ms = Math.round(performance.now() - dnsStart);
    } catch (dnsErr) {
      // Fallback to dns.lookup (uses OS resolver — resolves host.docker.internal, /etc/hosts, etc.)
      try {
        const { address } = await dns.lookup(hostname);
        resolvedIp = address;
        result.dns_ms = Math.round(performance.now() - dnsStart);
      } catch (lookupErr) {
        result.dns_ms = Math.round(performance.now() - dnsStart);
        result.error = `DNS_FAIL: ${lookupErr.code || lookupErr.message}`;
        trackResult(targetUrl, true);
        return result;
      }
    }

    const sslPromise = isHttps ? getSslDaysLeft(hostname) : Promise.resolve(null);

    // Use port from URL, or default to 443/80
    const targetPort = url.port ? parseInt(url.port) : (isHttps ? 443 : 80);

    await new Promise((resolve, reject) => {
      const reqStart = performance.now();
      let tcpConnectedAt = null;
      let tlsConnectedAt = null;
      let firstByteAt = null;
      let totalBytes = 0;

      const req = lib.request(
        {
          hostname: resolvedIp || hostname,
          path: url.pathname + url.search,
          port: targetPort,
          method: "GET",
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; IncidentIQ-Probe/1.0; +https://incidentiq.dev)",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            Host: hostname,
          },
          timeout: REQUEST_TIMEOUT_MS,
          ...(isHttps ? { servername: hostname, rejectUnauthorized: false } : {}),
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

    result.ssl_days_left = await sslPromise;

    // Only count 5xx and connection failures as errors.
    // 3xx/4xx are expected from login pages, WAFs, and bot-protection — not real downtime.
    const isError = !result.status_code || result.status_code >= 500;
    result.error_rate = trackResult(targetUrl, isError);

  } catch (err) {
    result.error = err.message;
    result.error_rate = trackResult(targetUrl, true);
  }

  return result;
}

const INSERT_SQL = `
  INSERT INTO metrics.probe_readings (
    url, probed_at, ttfb_ms, dns_ms, tcp_ms, tls_ms,
    status_code, error_rate, ssl_days_left, response_size, content_type
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
`;

async function publishToRedis(reading, isTrainingOnly) {
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
        "url", reading.url,
        "is_training_only", isTrainingOnly ? "1" : "0"
      );
    }
  } catch (err) {
    console.error(`[REDIS ERROR] ${reading.url}: ${err.message}`);
  }
}

async function writeReading(reading, isTrainingOnly) {
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
    await publishToRedis(reading, isTrainingOnly);
  } catch (err) {
    console.error(`[DB ERROR] ${reading.url}: ${err.message}`);
  }
}

async function probeAll() {
  // Refresh targets from DB before each probe cycle
  await refreshTargetsFromDB();

  if (activeTargets.length === 0) {
    console.log(`[${new Date().toISOString()}] No targets to probe.`);
    return;
  }

  const start = Date.now();
  console.log(`[${new Date().toISOString()}] Probing ${activeTargets.length} URLs...`);

  const results = await Promise.allSettled(
    activeTargets.map(async (target) => {
      const reading = await probe(target.probe_url);

      const status = reading.error
        ? `ERROR: ${reading.error}`
        : `${reading.status_code} | TTFB: ${reading.ttfb_ms}ms | DNS: ${reading.dns_ms}ms | SSL: ${reading.ssl_days_left?.toFixed(0)}d`;
      const flag = target.is_training_only ? '[TRAIN]' : '[USER]';
      console.log(`  ${flag} ${target.name.padEnd(15)} ${status}`);

      await writeReading(reading, target.is_training_only);
      return reading;
    })
  );

  const elapsed = Date.now() - start;
  const ok = results.filter((r) => r.status === "fulfilled" && !r.value.error).length;
  const errors = activeTargets.length - ok;

  console.log(`  Done in ${elapsed}ms | OK: ${ok} | Errors: ${errors}\n`);
}

// ── Bootstrap ─────────────────────────────────────────────────
async function bootstrap() {
  console.log("IncidentIQ Website Probe starting...");

  // Seed training URLs on startup
  await seedTrainingUrls();

  // Initial target refresh + first probe
  await probeAll();

  // Schedule probes every 30 seconds
  setInterval(() => probeAll().catch(console.error), PROBE_INTERVAL_MS);
}

bootstrap().catch(console.error);

process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  await pool.end();
  process.exit(0);
});