// Demo data source: the dashboard API payloads as static JSON, used when AUTOBOT_ROOT has
// no status.py. Every value under demo-data/ is synthetic (scripts/generate-demo-data.mjs).
import { readFileSync } from "fs";
import { join } from "path";

export const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
export const EXPERIMENT_ID = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_(.+)$/;

// Moves activity timestamps forward so the snapshot reads as current ("wakes in 2h", not
// "overdue by 40 days"). Market dates (YYYY-MM-DD) are history and stay where they are.
export function rebase(value, offsetMs) {
  if (Array.isArray(value)) return value.map(item => rebase(item, offsetMs));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebase(item, offsetMs)]));
  }
  if (typeof value !== "string") return value;
  if (DATETIME.test(value)) return new Date(Date.parse(value) + offsetMs).toISOString().replace(".000Z", "Z");
  // Experiment ids start with their UTC creation time; keep them in step with the rest.
  const id = EXPERIMENT_ID.exec(value);
  if (id) {
    const [, y, mo, d, h, mi, sec, rest] = id;
    const stamp = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec) + offsetMs).toISOString();
    return `${stamp.slice(0, 10).replaceAll("-", "")}_${stamp.slice(11, 19).replaceAll(":", "")}_${rest}`;
  }
  return value;
}

export function demoPayload(root, view, now = Date.now()) {
  const payload = JSON.parse(readFileSync(join(root, "api", `${view}.json`), "utf8"));
  const generatedAt = Date.parse(payload.generated_at);
  const { generated_at: _ignored, ...body } = payload;
  return Number.isFinite(generatedAt) ? rebase(body, now - generatedAt) : body;
}
