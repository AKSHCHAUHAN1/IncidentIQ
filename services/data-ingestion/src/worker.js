import { redis } from "./redis.js";
import { pool } from "./postgres.js";
import { writeToVictoria } from "./victoria.js";
import fetch from "node-fetch";

const ML_URL = process.env.ML_URL || "http://ml-service:8000/predict";
const INPUT_WINDOW = parseInt(process.env.INPUT_WINDOW || "20");

let running = true;

// sliding window per service
const serviceBuffers = new Map();

export async function startWorker() {
  console.log("Starting ingestion worker...");

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
        const obj = {};
        for (let i = 0; i < fields.length; i += 2) {
          obj[fields[i]] = fields[i + 1];
        }

        const metric = {
          time: new Date(),
          service_id: obj.service_id,
          metric_name: obj.metric_name,
          value: parseFloat(obj.value),
        };

        // Store in DB
        await pool.query(
          `INSERT INTO metrics.raw_metrics(time, service_id, metric_name, value)
           VALUES($1, $2, $3, $4)`,
          [metric.time, metric.service_id, metric.metric_name, metric.value]
        );

        try {
          await writeToVictoria(metric);
        } catch (err) {
          console.warn("Victoria write failed:", err.message);
        }

       // ===== ML FEATURE BUFFER (CORRECT) =====

       if (!serviceBuffers.has(metric.service_id)) {
        serviceBuffers.set(metric.service_id, {});
       }
      
       const state = serviceBuffers.get(metric.service_id);
      
       // store latest metric value by name
       state[metric.metric_name] = metric.value;

       const required = ["cpu", "memory", "request_rate", "error_rate", "latency"];

       // check if we have full feature set
       const ready = required.every(k => state[k] !== undefined);

       if (ready) {
         if (!state.window) state.window = [];

         const featureVector = [
          state.cpu,
          state.memory,
          state.request_rate,
          state.error_rate,
          state.latency
         ];

         state.window.push(featureVector);

         if (state.window.length > INPUT_WINDOW) {
          state.window.shift();
         }
        
         if (state.window.length === INPUT_WINDOW) {
          await triggerPrediction(metric.service_id, state.window);
         }
       }

        await redis.xack("metrics_stream", "group1", id);
      }
    } catch (err) {
      console.error("Worker error:", err.message);
    }
  }
}

async function triggerPrediction(serviceId, window) {
  try {
    const payload = {
      data: window // adapt to model shape if needed
    };

    const res = await fetch(ML_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.error("ML prediction failed:", await res.text());
      return;
    }

    const result = await res.json();

    console.log("Prediction for", serviceId, result);

    // Forward to decision engine
    await fetch("http://decision-engine:5000/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id: serviceId,
        prediction: result,
        current_metrics: {
          cpu: state.cpu,
          memory: state.memory,
          request_rate: state.request_rate,
          error_rate: state.error_rate,
          latency: state.latency
        }
      }),
    });

  } catch (err) {
    console.error("Prediction error:", err.message);
  }
}

export function stopWorker() {
  running = false;
}