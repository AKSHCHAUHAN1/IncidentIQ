import axios from "axios";

export async function writeToVictoria(metric) {
  const line = `${metric.metric_name},service=${metric.service_id} value=${metric.value}`;

  await axios.post(
    `${process.env.VICTORIA_URL}/api/v1/import/prometheus`,
    line,
    { headers: { "Content-Type": "text/plain" } }
  );
}
