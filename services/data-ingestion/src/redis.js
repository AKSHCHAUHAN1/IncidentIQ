import Redis from "ioredis";

export const redis = new Redis({
  host: process.env.REDIS_HOST || "redis",
  port: 6379,
  maxRetriesPerRequest: null
});

redis.on("connect", () => console.log("Redis connected"));
redis.on("error", (err) => console.error("Redis error:", err.message));
