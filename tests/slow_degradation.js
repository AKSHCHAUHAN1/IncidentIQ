import http from 'k6/http';
import { sleep } from 'k6';

export const options = {
  // A much slower ramp-up to the massive 2000 VU load.
  // This gives the target server time to queue requests and experience 
  // high TTFB (Time-To-First-Byte) before it eventually crashes.
  stages: [
    { duration: '2m', target: 500  },   // Slowly build to 500
    { duration: '3m', target: 1000 },   // Gently push to 1000
    { duration: '4m', target: 2000 },   // Long, slow climb to maximum 2000
    { duration: '2m', target: 2000 },   // Hold the maximum load
    { duration: '1m', target: 0    },   // Cool down
  ],
  thresholds: {
    http_req_duration: ['p(95)<5000'],
  },
};

export default function () {
  http.get('<<link>>');
  
  // Set back to 0.1 to generate enough raw traffic, but rely on the 
  // slow stage durations above to prevent instant connection refusal.
  sleep(0.1);
}
