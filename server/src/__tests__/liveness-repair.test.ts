import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

import { heartbeatService } from "../services/heartbeat.ts";
import { recoveryService } from "../services/recovery/service.ts";
import {
  ISSUE_LIVENESS_REPAIR_WAKE_REASON,
  buildIssueLivenessRepairWakeIdempotencyKey,
  repairBlockedNoLivePathToTodo,
} from "../services/recovery/liveness-repair.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres liveness-repair tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type WakeSeed = {
  id: string;
  reason: string;
  payload: Record<string, unknown>;
  contextSnapshot: Record<string, unknown>;
};

describeEmbeddedPostgres("heartbeat liveness repair action — blocked without live path", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-liveness-repair-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 60_000);

  async function seedCompanyWithAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "test_adapter",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId, issuePrefix };
  }

  async function insertBlockedIssue(opts: {
    companyId: string;
    assigneeAgentId: string | null;
    blockedTransitionAt?: Date | null;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: opts.companyId,
      title: "Stale blocked — no first-class blocker on file",
      status: "blocked",
      priority: "high",
      assigneeAgentId: opts.assigneeAgentId,
      issueNumber: 1,
      identifier: `L-${issueId.slice(0, 6)}`,
      blockedTransitionAt: opts.blockedTransitionAt ?? new Date(Date.now() - 60 * 60 * 1000),
    });
    return issueId;
  }

  async function insertLiveBlocker(opts: {
    companyId: string;
    relatedIssueId: string;
  }) {
    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId: opts.companyId,
      title: "Active blocker still in progress",
      status: "todo",
      priority: "high",
      issueNumber: 2,
      identifier: `L-${blockerIssueId.slice(0, 6)}`,
    });
    await db.insert(issueRelations).values({
      companyId: opts.companyId,
      issueId: blockerIssueId,
      relatedIssueId: opts.relatedIssueId,
      type: "blocks",
    });
    return blockerIssueId;
  }

  function collectEnqueueWakeup() {
    const calls: Array<{ agentId: string; opts: Parameters<ReturnType<typeof recoveryService> extends never ? never : never>[1] | undefined }> = [];
    const enqueueWakeup = vi.fn(
      async (agentId: string, opts?: Parameters<typeof recoveryService>[1] extends never ? never : never) => {
        calls.push({ agentId, opts });
        return { id: randomUUID() };
      },
    );
    return { enqueueWakeup, calls };
  }

  it("repairs an agent-assigned blocked issue with no live blocker and queues exactly one wake for the unchanged assignee", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent();
    const blockedTransitionAt = new Date(Date.now() - 30 * 60 * 1000);
    const issueId = await insertBlockedIssue({
      companyId,
      assigneeAgentId: agentId,
      blockedTransitionAt,
    });

    const { enqueueWakeup, calls } = collectEnqueueWakeup();
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.repairBlockedNoLivePathToTodo({
      companyId,
      issueId,
      source: "test.liveness_repair",
      enqueueWakeupOverride: enqueueWakeup as unknown as Parameters<typeof heartbeat.repairBlockedNoLivePathToTodo>[0]["enqueueWakeupOverride"],
    });

    expect(result.outcome).toBe("repaired_and_woke");
    expect(result.wakeEnqueued).toBe(true);
    expect(result.assigneeAgentId).toBe(agentId);
    expect(result.previousStatus).toBe("blocked");
    expect(result.nextStatus).toBe("todo");
    expect(result.wakeIdempotencyKey).toBe(
      buildIssueLivenessRepairWakeIdempotencyKey({
        companyId,
        issueId,
        assigneeAgentId: agentId,
        blockedTransitionAt,
      }),
    );
    expect(result.wakeId).toBeTruthy();

    expect(calls).toHaveLength(1);
    expect(calls[0].agentId).toBe(agentId);
    expect(calls[0].opts?.reason).toBe(ISSUE_LIVENESS_REPAIR_WAKE_REASON);
    expect(calls[0].opts?.idempotencyKey).toBe(result.wakeIdempotencyKey);
    expect((calls[0].opts?.payload as Record<string, unknown> | undefined)?.issueId).toBe(issueId);
    expect((calls[0].opts?.payload as Record<string, unknown> | undefined)?.previousStatus).toBe("blocked");
    expect((calls[0].opts?.payload as Record<string, unknown> | undefined)?.nextStatus).toBe("todo");

    const issueRow = await db
      .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issueRow).toMatchObject({ status: "todo", assigneeAgentId: agentId });

    const auditRow = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "issue.liveness_repair"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(auditRow).not.toBeNull();
    expect(auditRow?.details).toMatchObject({
      previousStatus: "blocked",
      nextStatus: "todo",
      wakeEnqueued: true,
      outcome: "repaired_and_woke",
    });
  });

  it("does not enqueue a wake when an active heartbeat run already exists for the issue", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent();
    const issueId = await insertBlockedIssue({
      companyId,
      assigneeAgentId: agentId,
    });
    const runningRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runningRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
      startedAt: new Date(),
      contextSnapshot: { issueId, taskId: issueId, source: "scheduler" },
    });

    const { enqueueWakeup, calls } = collectEnqueueWakeup();
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.repairBlockedNoLivePathToTodo({
      companyId,
      issueId,
      source: "test.liveness_repair",
      enqueueWakeupOverride: enqueueWakeup as unknown as Parameters<typeof heartbeat.repairBlockedNoLivePathToTodo>[0]["enqueueWakeupOverride"],
    });

    expect(result.outcome).toBe("active_path_present");
    expect(result.wakeEnqueued).toBe(false);
    expect(calls).toHaveLength(0);

    const issueRow = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issueRow?.status).toBe("blocked");

    const wakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(wakes).toHaveLength(0);
  });

  it("does not repair an issue that still has an unresolved first-class blocker", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent();
    const issueId = await insertBlockedIssue({
      companyId,
      assigneeAgentId: agentId,
    });
    await insertLiveBlocker({ companyId, relatedIssueId: issueId });

    const { enqueueWakeup, calls } = collectEnqueueWakeup();
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.repairBlockedNoLivePathToTodo({
      companyId,
      issueId,
      source: "test.liveness_repair",
      enqueueWakeupOverride: enqueueWakeup as unknown as Parameters<typeof heartbeat.repairBlockedNoLivePathToTodo>[0]["enqueueWakeupOverride"],
    });

    expect(result.outcome).toBe("has_live_blocker");
    expect(result.wakeEnqueued).toBe(false);
    expect(calls).toHaveLength(0);

    const issueRow = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issueRow?.status).toBe("blocked");
  });

  it("does not repair an issue whose status is not blocked", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Already in todo — sweep should be idempotent",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `L-${issueId.slice(0, 6)}`,
    });

    const { enqueueWakeup, calls } = collectEnqueueWakeup();
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.repairBlockedNoLivePathToTodo({
      companyId,
      issueId,
      source: "test.liveness_repair",
      enqueueWakeupOverride: enqueueWakeup as unknown as Parameters<typeof heartbeat.repairBlockedNoLivePathToTodo>[0]["enqueueWakeupOverride"],
    });

    expect(result.outcome).toBe("not_blocked");
    expect(calls).toHaveLength(0);
  });

  it("repairs and skips the wake when the blocked issue has no agent assignee", async () => {
    const { companyId } = await seedCompanyWithAgent();
    const issueId = await insertBlockedIssue({
      companyId,
      assigneeAgentId: null,
    });

    const { enqueueWakeup, calls } = collectEnqueueWakeup();
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.repairBlockedNoLivePathToTodo({
      companyId,
      issueId,
      source: "test.liveness_repair",
      enqueueWakeupOverride: enqueueWakeup as unknown as Parameters<typeof heartbeat.repairBlockedNoLivePathToTodo>[0]["enqueueWakeupOverride"],
    });

    expect(result.outcome).toBe("repaired_wake_skipped_no_assignee");
    expect(result.wakeEnqueued).toBe(false);
    expect(calls).toHaveLength(0);

    const issueRow = await db
      .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issueRow).toMatchObject({ status: "todo", assigneeAgentId: null });
  });

  it("is idempotent across repeated sweep passes via the stable idempotency key", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent();
    const blockedTransitionAt = new Date(Date.now() - 5 * 60 * 1000);
    const issueId = await insertBlockedIssue({
      companyId,
      assigneeAgentId: agentId,
      blockedTransitionAt,
    });

    const { enqueueWakeup, calls } = collectEnqueueWakeup();
    const heartbeat = heartbeatService(db);
    const first = await heartbeat.repairBlockedNoLivePathToTodo({
      companyId,
      issueId,
      source: "test.liveness_repair",
      enqueueWakeupOverride: enqueueWakeup as unknown as Parameters<typeof heartbeat.repairBlockedNoLivePathToTodo>[0]["enqueueWakeupOverride"],
    });
    expect(first.outcome).toBe("repaired_and_woke");

    const second = await heartbeat.repairBlockedNoLivePathToTodo({
      companyId,
      issueId,
      source: "test.liveness_repair",
      enqueueWakeupOverride: enqueueWakeup as unknown as Parameters<typeof heartbeat.repairBlockedNoLivePathToTodo>[0]["enqueueWakeupOverride"],
    });
    expect(second.outcome).toBe("not_blocked");
    expect(calls).toHaveLength(1);
  });

  it("respects an existing pending wake-targeting interaction without queuing another wake", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent();
    const issueId = await insertBlockedIssue({
      companyId,
      assigneeAgentId: agentId,
    });
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: { version: 1, prompt: "Continue?" },
    });

    const { enqueueWakeup, calls } = collectEnqueueWakeup();
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.repairBlockedNoLivePathToTodo({
      companyId,
      issueId,
      source: "test.liveness_repair",
      enqueueWakeupOverride: enqueueWakeup as unknown as Parameters<typeof heartbeat.repairBlockedNoLivePathToTodo>[0]["enqueueWakeupOverride"],
    });

    expect(result.outcome).toBe("interaction_pending");
    expect(calls).toHaveLength(0);
  });
});

describeEmbeddedPostgres("heartbeat liveness repair sweep — blocked without live path", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-liveness-repair-sweep-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 60_000);

  it("repairs every queued blocked-no-live-path candidate and queues exactly one wake per assignee", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `SW${companyId.slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "test_adapter",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
      permissions: {},
    });

    const repairable = [randomUUID(), randomUUID()];
    for (const id of repairable) {
      await db.insert(issues).values({
        id,
        companyId,
        title: "Repairable stale blocked",
        status: "blocked",
        priority: "high",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `SW-${id.slice(0, 6)}`,
        blockedTransitionAt: new Date(Date.now() - 10 * 60 * 1000),
      });
    }
    const blockedWithLiveBlocker = randomUUID();
    await db.insert(issues).values({
      id: blockedWithLiveBlocker,
      companyId,
      title: "Stale blocked but live blocker on file",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber: 2,
      identifier: `SW-${blockedWithLiveBlocker.slice(0, 6)}`,
    });
    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Active blocker",
      status: "in_progress",
      priority: "high",
      issueNumber: 3,
      identifier: `SW-${blockerIssueId.slice(0, 6)}`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedWithLiveBlocker,
      type: "blocks",
    });

    const enqueueWakeup = vi.fn(
      async () => ({ id: randomUUID() }),
    );
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileBlockedNoLivePathLiveness();

    expect(result.checked).toBeGreaterThan(2);
    expect(result.repaired).toBe(repairable.length);
    expect(result.wakeEnqueued).toBe(repairable.length);
    expect(result.liveBlocker).toBe(1);
    expect(new Set(result.issueIds)).toEqual(new Set(repairable));

    expect(enqueueWakeup).toHaveBeenCalledTimes(repairable.length);
    for (const call of enqueueWakeup.mock.calls) {
      expect(call[0]).toBe(agentId);
      const opts = call[1] as Parameters<typeof enqueueWakeup>[1];
      expect(opts?.reason).toBe(ISSUE_LIVENESS_REPAIR_WAKE_REASON);
      expect(typeof opts?.idempotencyKey).toBe("string");
    }

    for (const id of repairable) {
      const issueRow = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0]);
      expect(issueRow?.status).toBe("todo");
    }

    const stillBlocked = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, blockedWithLiveBlocker))
      .then((rows) => rows[0]);
    expect(stillBlocked?.status).toBe("blocked");
  });

  it("is a no-op when no candidates are present", async () => {
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }));
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileBlockedNoLivePathLiveness();

    expect(result).toMatchObject({
      checked: 0,
      repaired: 0,
      wakeEnqueued: 0,
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });
});

describe("repairBlockedNoLivePathToTodo — idempotency key shape", () => {
  it("hashes the same key for the same company/issue/assignee/cycle", () => {
    const cycle = new Date("2026-09-15T07:00:00.000Z");
    const a = buildIssueLivenessRepairWakeIdempotencyKey({
      companyId: "c",
      issueId: "i",
      assigneeAgentId: "a",
      blockedTransitionAt: cycle,
    });
    const b = buildIssueLivenessRepairWakeIdempotencyKey({
      companyId: "c",
      issueId: "i",
      assigneeAgentId: "a",
      blockedTransitionAt: cycle.toISOString(),
    });
    expect(a).toBe(b);
    expect(a.startsWith(`${ISSUE_LIVENESS_REPAIR_WAKE_REASON}:c:i:a:`)).toBe(true);
  });

  it("treats null and a non-date string as the same none cycle", () => {
    const a = buildIssueLivenessRepairWakeIdempotencyKey({
      companyId: "c",
      issueId: "i",
      assigneeAgentId: "a",
      blockedTransitionAt: null,
    });
    const b = buildIssueLivenessRepairWakeIdempotencyKey({
      companyId: "c",
      issueId: "i",
      assigneeAgentId: "a",
      blockedTransitionAt: "not-a-date",
    });
    expect(a).toBe(b);
    expect(a.endsWith(":none")).toBe(true);
  });

  it("re-export surface is the documented reason string", () => {
    expect(ISSUE_LIVENESS_REPAIR_WAKE_REASON).toBe("issue_liveness_repair");
    expect(typeof repairBlockedNoLivePathToTodo).toBe("function");
  });
});