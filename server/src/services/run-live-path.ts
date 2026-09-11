export const DEFAULT_STALE_QUEUED_RUN_MS = 2 * 60 * 60 * 1000;

export function resolveStaleQueuedRunMs(
  raw: string | undefined = process.env.PAPERCLIP_STALE_QUEUED_RUN_MS,
): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_QUEUED_RUN_MS;
}

export const STALE_QUEUED_RUN_MS = resolveStaleQueuedRunMs();

const TERMINAL_RUN_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "timed_out",
]);

const UNCONDITIONALLY_LIVE_STATUSES = new Set([
  "running",
  "scheduled_retry",
  "claimed",
  "deferred_issue_execution",
]);

export type RunLivePathInput = {
  status: string;
  startedAt?: Date | string | null;
  createdAt?: Date | string | null;
};

function toEpochMs(value: Date | string | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function isRunLivePath(
  run: RunLivePathInput,
  now: Date | string | number = Date.now(),
  staleQueuedRunMs: number = STALE_QUEUED_RUN_MS,
): boolean {
  if (TERMINAL_RUN_STATUSES.has(run.status)) return false;
  if (UNCONDITIONALLY_LIVE_STATUSES.has(run.status)) return true;
  if (run.status !== "queued") return false;
  if (run.startedAt != null && run.startedAt !== "") return true;
  const createdAtMs = toEpochMs(run.createdAt);
  if (createdAtMs == null) return true;
  const nowMs = toEpochMs(now) ?? Date.now();
  return nowMs - createdAtMs <= staleQueuedRunMs;
}
