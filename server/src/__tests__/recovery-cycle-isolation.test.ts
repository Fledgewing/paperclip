import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

import {
  recoveryService,
  dropCycleFormingBlockerIssueIds,
} from "../services/recovery/service.ts";
import { collectDispositionRepairSourceState } from "../services/recovery/disposition-repair.ts";
import { logger } from "../middleware/logger.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres recovery cycle-isolation tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("recovery reconcileActiveRecoveryActions cycle isolation (CAN-4297)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-cycle-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(issueComments);
    await db.delete(issueRecoveryActions);
    await db.delete(issueThreadInteractions);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId, issuePrefix };
  }

  async function insertIssue(input: {
    companyId: string;
    agentId: string;
    identifier: string;
    issueNumber: number;
    status: string;
    parentId?: string | null;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      parentId: input.parentId ?? null,
      title: `Recovery cycle isolation ${input.identifier}`,
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.agentId,
      issueNumber: input.issueNumber,
      identifier: input.identifier,
    });
    return issueId;
  }

  async function seedHealthyOpenChild(input: {
    companyId: string;
    agentId: string;
    parentId: string;
    identifier: string;
    issueNumber: number;
    blockedBySource?: boolean;
  }) {
    const childId = await insertIssue({
      companyId: input.companyId,
      agentId: input.agentId,
      identifier: input.identifier,
      issueNumber: input.issueNumber,
      status: "blocked",
      parentId: input.parentId,
    });
    if (input.blockedBySource) {
      await db.insert(issueRelations).values({
        companyId: input.companyId,
        issueId: input.parentId,
        relatedIssueId: childId,
        type: "blocks",
      });
    }
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId: input.companyId,
      issueId: childId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: { version: 1, prompt: "Confirm the disposition." },
    });
    return childId;
  }

  async function seedActiveAction(input: {
    companyId: string;
    agentId: string;
    sourceIssueId: string;
    wakePolicyType:
      | "bounded_recovery_owner"
      | "bounded_owner_disposition_repair";
    attemptCount?: number;
    maxAttempts?: number;
  }) {
    const sourceIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, input.sourceIssueId))
      .then((rows) => rows[0]!);
    const sourceState = await collectDispositionRepairSourceState(db, {
      issue: sourceIssue,
    });
    return db
      .insert(issueRecoveryActions)
      .values({
        companyId: input.companyId,
        sourceIssueId: input.sourceIssueId,
        kind: "deliberate_wait_without_target",
        status: "active",
        ownerType: "agent",
        ownerAgentId: input.agentId,
        previousOwnerAgentId: input.agentId,
        returnOwnerAgentId: input.agentId,
        cause: "deliberate_wait_without_target",
        fingerprint: sourceState.fingerprint,
        evidence: { sourceStateFingerprint: sourceState.fingerprint },
        nextAction: "Record a durable disposition.",
        wakePolicy: {
          type: input.wakePolicyType,
          attempt: input.attemptCount ?? 1,
          maxAttempts: input.maxAttempts ?? 5,
        },
        attemptCount: input.attemptCount ?? 1,
        maxAttempts: input.maxAttempts ?? 5,
        timeoutAt: new Date(Date.now() - 60_000),
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function actionRow(actionId: string) {
    return db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, actionId))
      .then((rows) => rows[0] ?? null);
  }

  async function sourceBlockerIssueIds(companyId: string, sourceIssueId: string) {
    const rows = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, sourceIssueId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    return rows.map((row) => row.blockerIssueId).sort();
  }

  it("processes the second active action when the first would form a blocking cycle", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent();
    // CAN-619 live shape: source blocked, zero blockers, healthy open child
    // that is blocked by the source. Restoring blockedBy on that child is a
    // 2-cycle; pre-fix the 422 escaped the loop and aborted every action
    // after it on every tick.
    const source1 = await insertIssue({
      companyId,
      agentId,
      identifier: `${issuePrefix}-1`,
      issueNumber: 1,
      status: "blocked",
    });
    const child1 = await seedHealthyOpenChild({
      companyId,
      agentId,
      parentId: source1,
      identifier: `${issuePrefix}-2`,
      issueNumber: 2,
      blockedBySource: true,
    });
    const action1 = await seedActiveAction({
      companyId,
      agentId,
      sourceIssueId: source1,
      wakePolicyType: "bounded_recovery_owner",
    });

    const source2 = await insertIssue({
      companyId,
      agentId,
      identifier: `${issuePrefix}-3`,
      issueNumber: 3,
      status: "blocked",
    });
    const child2 = await seedHealthyOpenChild({
      companyId,
      agentId,
      parentId: source2,
      identifier: `${issuePrefix}-4`,
      issueNumber: 4,
    });
    const action2 = await seedActiveAction({
      companyId,
      agentId,
      sourceIssueId: source2,
      wakePolicyType: "bounded_recovery_owner",
    });

    const warnSpy = vi.spyOn(logger, "warn");

    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => null),
    });
    const result = await recovery.reconcileActiveRecoveryActions();

    const [firstAction, secondAction] = await Promise.all([
      actionRow(action1.id),
      actionRow(action2.id),
    ]);

    // The cycle-forming action is skipped-and-logged and never blocks the
    // pass; the healthy action after it is still processed.
    expect(firstAction).toMatchObject({ status: "active" });
    expect(secondAction).toMatchObject({
      status: "resolved",
      outcome: "restored",
      resolutionNote: "durable_path_restored:healthy_child",
    });
    await expect(sourceBlockerIssueIds(companyId, source1)).resolves.toEqual([]);
    await expect(sourceBlockerIssueIds(companyId, source2)).resolves.toEqual([
      child2,
    ]);
    expect(result.resolved).toBeGreaterThanOrEqual(1);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    const cycleWarnings = warnSpy.mock.calls.filter(
      (call) =>
        call[1] === "dropped cycle-forming healthy children from blocked-by repair",
    );
    expect(cycleWarnings).toHaveLength(1);
    expect(cycleWarnings[0]?.[0]).toMatchObject({
      issueId: source1,
      droppedChildIds: [child1],
    });
  });

  it("filters cycle-forming children out of blockedByIssueIds while retaining siblings", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent();
    const source = await insertIssue({
      companyId,
      agentId,
      identifier: `${issuePrefix}-1`,
      issueNumber: 1,
      status: "blocked",
    });
    const cycleChild = await seedHealthyOpenChild({
      companyId,
      agentId,
      parentId: source,
      identifier: `${issuePrefix}-2`,
      issueNumber: 2,
      blockedBySource: true,
    });
    const safeChild = await seedHealthyOpenChild({
      companyId,
      agentId,
      parentId: source,
      identifier: `${issuePrefix}-3`,
      issueNumber: 3,
    });
    const action = await seedActiveAction({
      companyId,
      agentId,
      sourceIssueId: source,
      wakePolicyType: "bounded_recovery_owner",
    });

    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => null),
    });
    await recovery.reconcileActiveRecoveryActions();

    await expect(sourceBlockerIssueIds(companyId, source)).resolves.toEqual([
      safeChild,
    ]);
    expect((await actionRow(action.id))?.status).toBe("resolved");
  });

  it("escalates without any blockedBy write when the only healthy child blocks the source", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent();
    const source = await insertIssue({
      companyId,
      agentId,
      identifier: `${issuePrefix}-1`,
      issueNumber: 1,
      status: "blocked",
    });
    const child = await seedHealthyOpenChild({
      companyId,
      agentId,
      parentId: source,
      identifier: `${issuePrefix}-2`,
      issueNumber: 2,
      blockedBySource: true,
    });
    const action = await seedActiveAction({
      companyId,
      agentId,
      sourceIssueId: source,
      wakePolicyType: "bounded_owner_disposition_repair",
      attemptCount: 5,
      maxAttempts: 5,
    });

    const recovery = recoveryService(db, {
      enqueueWakeup: vi.fn(async () => null),
    });
    const result = await recovery.reconcileActiveRecoveryActions();

    expect(result.resolved).toBe(0);
    expect(result.escalated).toBe(1);
    // No blocked-by update was attempted: the source still has zero blockers,
    // and the cycle-forming child never entered blockedByIssueIds.
    await expect(sourceBlockerIssueIds(companyId, source)).resolves.toEqual([]);
    const updatedAction = await actionRow(action.id);
    expect(updatedAction).toMatchObject({
      ownerType: "board",
      resolutionNote: "unchanged_source_state_exhausted",
    });
    expect(updatedAction?.wakePolicy).toMatchObject({
      type: "board_escalation",
    });
    void child;
  });

  it("keeps processing remaining actions when one reconcile throws mid-loop", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent();
    const source1 = await insertIssue({
      companyId,
      agentId,
      identifier: `${issuePrefix}-1`,
      issueNumber: 1,
      status: "blocked",
    });
    const cycleChild = await seedHealthyOpenChild({
      companyId,
      agentId,
      parentId: source1,
      identifier: `${issuePrefix}-2`,
      issueNumber: 2,
      blockedBySource: true,
    });
    const action1 = await seedActiveAction({
      companyId,
      agentId,
      sourceIssueId: source1,
      wakePolicyType: "bounded_recovery_owner",
    });

    const source2 = await insertIssue({
      companyId,
      agentId,
      identifier: `${issuePrefix}-3`,
      issueNumber: 3,
      status: "blocked",
    });
    const child2 = await seedHealthyOpenChild({
      companyId,
      agentId,
      parentId: source2,
      identifier: `${issuePrefix}-4`,
      issueNumber: 4,
    });
    const action2 = await seedActiveAction({
      companyId,
      agentId,
      sourceIssueId: source2,
      wakePolicyType: "bounded_recovery_owner",
    });

    // Fail the first cycle-guard query exactly once so exactly one action
    // throws inside the loop, then let everything through.
    let injected = 0;
    const faultyDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "select") {
          return (...args: unknown[]) => {
            const chain = (
              target.select as (...a: unknown[]) => Record<string, unknown>
            )(...args);
            return new Proxy(chain, {
              get(c, cprop, creceiver) {
                if (cprop === "from") {
                  return (...fa: unknown[]) => {
                    if (fa[0] === issueRelations) {
                      const relChain = c.from(...fa) as Record<string, unknown>;
                      return new Proxy(relChain, {
                        get(x, xprop) {
                          if (xprop === "where") {
                            return () => {
                              injected += 1;
                              if (injected === 1) {
                                return Promise.reject(
                                  new Error("simulated blocking-cycle guard failure"),
                                );
                              }
                              return Promise.resolve([]);
                            };
                          }
                          return Reflect.get(x, xprop, x);
                        },
                      });
                    }
                    return c.from(...fa);
                  };
                }
                return Reflect.get(c, cprop, creceiver);
              },
            });
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const errorSpy = vi.spyOn(logger, "error");

    const recovery = recoveryService(faultyDb, {
      enqueueWakeup: vi.fn(async () => null),
    });
    const result = await recovery.reconcileActiveRecoveryActions();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId,
        err: expect.objectContaining({
          message: "simulated blocking-cycle guard failure",
        }),
      }),
      "active recovery action reconcile failed; skipping action",
    );
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.resolved).toBeGreaterThanOrEqual(1);

    const [firstAction, secondAction] = await Promise.all([
      actionRow(action1.id),
      actionRow(action2.id),
    ]);
    const failed =
      firstAction?.status === "active" ? firstAction : secondAction!;
    const processed =
      firstAction?.status === "resolved" ? firstAction : secondAction!;
    expect(failed.id).not.toBe(processed.id);
    expect(processed).toMatchObject({ status: "resolved" });
    expect([action1.id, action2.id]).toContain(failed.id);
    expect([source1, source2]).toContain(processed.sourceIssueId);
    // The cycle-forming child stayed out of the surviving graph either way.
    expect(await sourceBlockerIssueIds(companyId, source1)).not.toContain(
      cycleChild,
    );
  });

  it("dropCycleFormingBlockerIssueIds drops exactly the cycle-forming candidates", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent();
    const source = await insertIssue({
      companyId,
      agentId,
      identifier: `${issuePrefix}-1`,
      issueNumber: 1,
      status: "blocked",
    });
    const directChild = await insertIssue({
      companyId,
      agentId,
      identifier: `${issuePrefix}-2`,
      issueNumber: 2,
      status: "in_progress",
      parentId: source,
    });
    const transitiveDescendant = await insertIssue({
      companyId,
      agentId,
      identifier: `${issuePrefix}-3`,
      issueNumber: 3,
      status: "in_progress",
      parentId: source,
    });
    const unrelated = await insertIssue({
      companyId,
      agentId,
      identifier: `${issuePrefix}-4`,
      issueNumber: 4,
      status: "in_progress",
    });
    await db.insert(issueRelations).values([
      // source blocks directChild directly
      {
        companyId,
        issueId: source,
        relatedIssueId: directChild,
        type: "blocks",
      },
      // directChild blocks transitiveDescendant, so transitiveDescendant
      // transitively sits behind the source.
      {
        companyId,
        issueId: directChild,
        relatedIssueId: transitiveDescendant,
        type: "blocks",
      },
      // unrelated blocks the source — it is not reachable from the source,
      // so adding it as a blocker forms no cycle.
      {
        companyId,
        issueId: unrelated,
        relatedIssueId: source,
        type: "blocks",
      },
    ]);

    const kept = await dropCycleFormingBlockerIssueIds(db, {
      companyId,
      issueId: source,
      candidateIssueIds: [
        directChild,
        transitiveDescendant,
        unrelated,
        source,
      ],
    });

    expect(kept.sort()).toEqual([unrelated].sort());
  });
});
