import { redis } from "./redis.js";
import { pool } from "./postgres.js";
import fetch from "node-fetch";

const ML_URL = process.env.ML_URL || "http://ml-service:8000/ensemble";
const DECISION_URL = process.env.DECISION_URL || "http://decision-engine:5000/evaluate";
const INPUT_WINDOW = parseInt(process.env.INPUT_WINDOW || "60", 10);

const REQUIRED_METRICS = ["ttfb_ms", "dns_ms", "error_rate", "ssl_days_left"];

let running = true;

// Sliding window + probe-sample assembler per service
const serviceBuffers = new Map();

function getState(serviceId) {
  if (!serviceBuffers.has(serviceId)) {
    serviceBuffers.set(serviceId, {
      sampleTs: null,
      currentSample: {},
      lastDispatchedSampleTs: null,
      window: [],
      lastSnapshot: {},
      url: null,
      isTrainingOnly: false,
    });
  }
  return serviceBuffers.get(serviceId);
}

function buildMetricText(metrics) {
  const ttfb = metrics.ttfb_ms ?? 0;
  const dns = metrics.dns_ms ?? 0;
  const errorRate = metrics.error_rate ?? 0;
  const ssl = metrics.ssl_days_left ?? 365;
  const status = metrics.status_code ?? 200;

  const tokens = [];

  if (ttfb < 250) tokens.push("ttfb_fast");
  else if (ttfb < 800) tokens.push("ttfb_moderate");
  else if (ttfb < 1500) tokens.push("ttfb_slow");
  else tokens.push("ttfb_very_slow");

  if (dns < 40) tokens.push("dns_fast");
  else if (dns < 120) tokens.push("dns_moderate");
  else if (dns < 300) tokens.push("dns_slow");
  else tokens.push("dns_very_slow");

  const ratio = ttfb / Math.max(dns, 1);
  if (ratio < 3) tokens.push("ratio_dns_dominant");
  else if (ratio < 7) tokens.push("ratio_balanced");
  else tokens.push("ratio_origin_dominant");

  if (errorRate < 1) tokens.push("errors_clean");
  else if (errorRate < 5) tokens.push("errors_low");
  else if (errorRate < 15) tokens.push("errors_high");
  else tokens.push("errors_critical");

  if (ssl < 7) tokens.push("ssl_critical");
  else if (ssl < 14) tokens.push("ssl_warning");
  else if (ssl < 30) tokens.push("ssl_soon");
  else tokens.push("ssl_ok");

  if (status >= 500) tokens.push("status_server_error");
  else if (status >= 400) tokens.push("status_client_error");
  else tokens.push("status_ok");

  return tokens.join(" ");
}

export async function startWorker() {
  console.log("Starting ingestion worker...");

  // Create consumer group (ignore error if already exists)
  await redis
    .xgroup("CREATE", "metrics_stream", "group1", "$", "MKSTREAM")
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
        // Parse flat field array into object
        const obj = {};
        for (let i = 0; i < fields.length; i += 2) {
          obj[fields[i]] = fields[i + 1];
        }

        const numericValue = parseFloat(obj.value);
        if (Number.isNaN(numericValue)) {
          await redis.xack("metrics_stream", "group1", id);
          continue;
        }

        const sampleTs = obj.sample_ts || new Date().toISOString();
        const metricTime = new Date(sampleTs);

        const metric = {
          time: Number.isNaN(metricTime.getTime()) ? new Date() : metricTime,
          service_id: obj.service_id,
          metric_name: obj.metric_name,
          value: numericValue,
          sample_ts: sampleTs,
          url: obj.url || null,
        };

        // Write complete samples to probe_readings (handled below after assembly)
        // Individual metrics are accumulated in the buffer first

        if (!metric.service_id || !metric.metric_name) {
          await redis.xack("metrics_stream", "group1", id);
          continue;
        }

        const state = getState(metric.service_id);

        if (state.sampleTs !== metric.sample_ts) {
          state.sampleTs = metric.sample_ts;
          state.currentSample = {};
        }

        if (metric.url) state.url = metric.url;
        if (obj.is_training_only !== undefined) state.isTrainingOnly = obj.is_training_only === "1";
        state.currentSample[metric.metric_name] = metric.value;

        const isReady = REQUIRED_METRICS.every((k) => state.currentSample[k] !== undefined);
        const notYetDispatched = state.lastDispatchedSampleTs !== metric.sample_ts;

        if (isReady && notYetDispatched) {
          const row = REQUIRED_METRICS.map((k) => state.currentSample[k] ?? 0);
          state.window.push(row);
          if (state.window.length > INPUT_WINDOW) state.window.shift();

          state.lastSnapshot = {
            ...state.currentSample,
            status_code: state.currentSample.status_code || 200,
            availability: state.currentSample.availability ?? 1,
          };

          if (state.window.length === INPUT_WINDOW) {
            const metricText = buildMetricText(state.lastSnapshot);
            await triggerPrediction(metric.service_id, state.window, state.lastSnapshot, metricText, state.url, state.isTrainingOnly);
          }

          state.lastDispatchedSampleTs = metric.sample_ts;
        }

        await redis.xack("metrics_stream", "group1", id);
      }
    } catch (err) {
      console.error("Worker error:", err?.message || err?.code || String(err));
    }
  }
}

async function triggerPrediction(serviceId, window, snapshot, metricText, url, isTrainingOnly) {
  // Skip ML call entirely for training-only URLs — they only feed raw data
  if (isTrainingOnly) {
    console.log(`[Worker] SKIP prediction for training-only URL: ${url || serviceId}`);
    return;
  }

  try {
    console.log(`[Worker] Triggering ML prediction for ${serviceId} (url=${url})`);
    const res = await fetch(ML_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        metrics_window: window,
        log_text: metricText,
      }),
    });

    if (!res.ok) {
      console.error("[Worker] ML prediction failed:", await res.text());
      return;
    }

    const result = await res.json();
    console.log(`[Worker] ML response for ${serviceId}:`, JSON.stringify(result).substring(0, 200));
    console.log(`[Worker] Prediction result for ${serviceId}:`, {
      severity: result.severity,
      confidence: result.confidence,
      root_cause: result.root_cause,
      breach_eta_min: result.breach_eta_min,
    });

    console.log(`[Worker] Sending to decision-engine for ${serviceId} (url=${url})`);
    await fetch(DECISION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id:      serviceId,
        prediction:      result,
        current_metrics: snapshot,
        metric_text:     metricText,
        url:             url,
      }),
    });
    console.log(`[Worker] Decision-engine call complete for ${serviceId}`);
  } catch (err) {
    console.error("[Worker] Prediction error:", err?.message || String(err));
  }
}

export function stopWorker() {
  running = false;
}