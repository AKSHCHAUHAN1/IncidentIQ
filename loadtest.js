// loadtest.js — aggressive version
import http from 'k6/http';
import { sleep } from 'k6';

export const options = {
  stages: [
    { duration: '1m', target: 500  },
    { duration: '3m', target: 1000 },
    { duration: '2m', target: 2000 },
    { duration: '2m', target: 0    },
  ],
  thresholds: {
    http_req_duration: ['p(95)<5000'],
  },
};

export default function () {
  http.get('http://65.2.131.84');
  sleep(0.1);
}