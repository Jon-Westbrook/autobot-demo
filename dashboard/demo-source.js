// Demo data source: the dashboard API payloads as static JSON, used when AUTOBOT_ROOT has
// no status.py. Every value under demo-data/ is synthetic (scripts/generate-demo-data.mjs).
import { readFileSync } from "fs";
import { join } from "path";

const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const EXPERIMENT_ID = /^(\d{4})(\d{2})(\d{2})_(\d{6}_.+)$/;
const DAY_MS = 86400000;

// Moves activity timestamps forward so the snapshot reads as current ("wakes in 2h", not
// "overdue by 40 days"). Market dates (YYYY-MM-DD) are history and stay where they are.
export function rebase(value, offsetMs) {
  if (Array.isArray(value)) return value.map(item => rebase(item, offsetMs));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebase(item, offsetMs)]));
  }
  if (typeof value !== "string") return value;
  if (DATETIME.test(value)) return new Date(Date.parse(value) + offsetMs).toISOString().replace(".000Z", "Z");
  const id = EXPERIMENT_ID.exec(value);
  if (id) {
    const day = new Date(Date.UTC(+id[1], +id[2] - 1, +id[3]) + Math.round(offsetMs / DAY_MS) * DAY_MS);
    return `${day.toISOString().slice(0, 10).replaceAll("-", "")}_${id[4]}`;
  }
  return value;
}

export function demoPayload(root, view, now = Date.now()) {
  const payload = JSON.parse(readFileSync(join(root, "api", `${view}.json`), "utf8"));
  const generatedAt = Date.parse(payload.generated_at);
  const { generated_at: _ignored, ...body } = payload;
  return Number.isFinite(generatedAt) ? rebase(body, now - generatedAt) : body;
}
