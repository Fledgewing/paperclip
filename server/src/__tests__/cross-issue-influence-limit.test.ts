import { describe, expect, it } from "vitest";
import {
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  CROSS_ISSUE_INFLUENCE_LIMIT,
  crossIssueInfluenceLimitError,
  evaluateCrossIssueInfluenceLimit,
  observeCrossIssueInfluence,
} from "../services/cross-issue-influence-limit.ts";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ACTING_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const TARGET_ISSUE_ID = "55555555-5555-4555-8555-555555555555";

type CounterDbOptions = {
  initialCount?: number;
  runOverrides?: Record<string, unknown> | null;
  // The issue the step-2 fallback should resolve to (null = no match).
  checkoutIssue?: { id: string } | null;
  // The issue returned by the step-3 target-issue lookup.
  targetIssue?: { assigneeAgentId: string } | null;
};

function counterDb(opts: CounterDbOptions = {}) {
  const initialCount = opts.initialCount ?? 0;
  // A literal `null` runOverrides means "run lookup returns no row" (the
  // missing-locked-run case). `undefined` / omitted means "use defaults".
  const runOverrides = opts.runOverrides;
  let observedCount = initialCount;
  const inserted: Array<Record<string, unknown>> = [];

  const tx = {
    select: (selection: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          if (Object.keys(selection).includes("count")) {
            return {
              then: (resolve: (rows: unknown[]) => unknown) => resolve([{ count: observedCount }]),
            };
          }
          if ("contextSnapshot" in selection) {
            return {
              for: () => ({
                then: (resolve: (rows: unknown[]) => unknown) =>
                  resolve(
                    runOverrides === null
                      ? []
                      : [
                          {
                            id: RUN_ID,
                            companyId: COMPANY_ID,
                            agentId: ACTING_AGENT_ID,
                            responsibleUserId: "user-1",
                            contextSnapshot: { issueId: SOURCE_ISSUE_ID },
                            ...(runOverrides ?? {}),
                          },
                        ],
                  ),
              }),
            };
          }
          if ("id" in selection) {
            return {
              limit: () => ({
                then: (resolve: (rows: unknown[]) => unknown) =>
                  resolve(opts.checkoutIssue ? [opts.checkoutIssue] : []),
              }),
            };
          }
          if ("assigneeAgentId" in selection) {
            return {
              limit: () => ({
                then: (resolve: (rows: unknown[]) => unknown) =>
                  resolve(opts.targetIssue ? [opts.targetIssue] : []),
              }),
            };
          }
          throw new Error("counterDb: unhandled select selection");
        },
      }),
    }),
    insert: () => ({
      values: async (value: Record<string, unknown>) => {
        inserted.push(value);
        if (value.action === "issue.cross_issue_influence_observed") observedCount += 1;
      },
    }),
  };

  return {
    db: {
      transaction: async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
    },
    inserted,
    get observedCount() {
      return observedCount;
    },
  };
}

describe("cross-issue influence limit rollout", () => {
  it("logs observations without enforcement during the one-week rollout", () => {
    const decision = evaluateCrossIssueInfluenceLimit({
      priorCount: CROSS_ISSUE_INFLUENCE_LIMIT,
      now: new Date(CROSS_ISSUE_INFLUENCE_ENFORCE_AT.getTime() - 1),
    });

    expect(decision).toMatchObject({
      allowed: true,
      mode: "log_only",
      count: CROSS_ISSUE_INFLUENCE_LIMIT + 1,
      cap: CROSS_ISSUE_INFLUENCE_LIMIT,
    });
  });

  it("allows the twentieth influence and fails closed on the twenty-first after the flip", () => {
    const now = CROSS_ISSUE_INFLUENCE_ENFORCE_AT;
    expect(evaluateCrossIssueInfluenceLimit({ priorCount: 19, now })).toMatchObject({
      allowed: true,
      mode: "enforce",
      count: 20,
      cap: 20,
    });

    const rejected = evaluateCrossIssueInfluenceLimit({ priorCount: 20, now });
    expect(rejected).toMatchObject({
      allowed: false,
      mode: "enforce",
      count: 21,
      cap: 20,
    });
    const capError = crossIssueInfluenceLimitError(rejected, {
      actorLabel: "Fable",
      issueIdentifier: "TASK-482",
    });
    expect(capError.details).toMatchObject({
      code: "cross_issue_influence_cap_exceeded",
      cap: 20,
      count: 21,
      mode: "enforce",
      enforceAt: CROSS_ISSUE_INFLUENCE_ENFORCE_AT.toISOString(),
    });
    // Plan §6: the 429 names the boundary, who can act, and the way forward.
    expect(capError.error).toContain("20");
    expect(capError.error).toContain("Who can act:");
    expect(capError.error).toContain("Try this:");
    expect(capError.error).toContain("next heartbeat");
    expect(capError.details.boundary).toContain("20");
    expect(capError.details.whoCanAct).toContain("Fable");
  });

  it("uses one durable counter for cross-issue comments, PATCH updates, and interaction resolutions", async () => {
    const fake = counterDb();
    const base = {
      companyId: COMPANY_ID,
      runId: RUN_ID,
      agentId: ACTING_AGENT_ID,
      targetIssueId: TARGET_ISSUE_ID,
      now: new Date(CROSS_ISSUE_INFLUENCE_ENFORCE_AT.getTime() - 1),
    } as const;

    await expect(observeCrossIssueInfluence(fake.db as never, { ...base, kind: "comment" }))
      .resolves.toMatchObject({ count: 1, allowed: true });
    await expect(observeCrossIssueInfluence(fake.db as never, { ...base, kind: "update" }))
      .resolves.toMatchObject({ count: 2, allowed: true });
    await expect(observeCrossIssueInfluence(fake.db as never, { ...base, kind: "interaction_resolution" }))
      .resolves.toMatchObject({ count: 3, allowed: true });

    expect(fake.observedCount).toBe(3);
    expect(fake.inserted.map((row) => (row.details as { kind: string }).kind))
      .toEqual(["comment", "update", "interaction_resolution"]);
  });

  it("counts an interaction resolution against a budget already spent on comments", async () => {
    const fake = counterDb({ initialCount: CROSS_ISSUE_INFLUENCE_LIMIT });

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: COMPANY_ID,
      runId: RUN_ID,
      agentId: ACTING_AGENT_ID,
      targetIssueId: TARGET_ISSUE_ID,
      kind: "interaction_resolution",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toMatchObject({
      allowed: false,
      mode: "enforce",
      count: CROSS_ISSUE_INFLUENCE_LIMIT + 1,
    });
    expect(fake.inserted).toEqual([
      expect.objectContaining({ action: "issue.cross_issue_influence_cap_rejected" }),
    ]);
  });

  it("does not count same-issue writes", async () => {
    const fake = counterDb({ runOverrides: { contextSnapshot: { issueId: TARGET_ISSUE_ID } } });
    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: COMPANY_ID,
      runId: RUN_ID,
      agentId: ACTING_AGENT_ID,
      targetIssueId: TARGET_ISSUE_ID,
      kind: "comment",
    })).resolves.toBeNull();
    expect(fake.inserted).toEqual([]);
  });

  it.each([
    ["missing", null],
    ["wrong-agent", { agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
    ["wrong-company", { companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
  ] as const)("fails closed for a %s locked run", async (_label, runOverrides) => {
    const fake = counterDb({ runOverrides });

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: COMPANY_ID,
      runId: RUN_ID,
      agentId: ACTING_AGENT_ID,
      targetIssueId: TARGET_ISSUE_ID,
      kind: "comment",
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "cross_issue_influence_run_context_required" },
    });
    expect(fake.inserted).toEqual([]);
  });

  it("fails closed before querying for a malformed run id", async () => {
    const fake = counterDb();

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: COMPANY_ID,
      runId: "attacker-controlled-run-id",
      agentId: ACTING_AGENT_ID,
      targetIssueId: TARGET_ISSUE_ID,
      kind: "comment",
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "cross_issue_influence_run_context_required" },
    });
    expect(fake.inserted).toEqual([]);
  });
});

describe("cross-issue influence limit: context-less timer/scheduler runs (CAN-1720)", () => {
  // CAN-1720: heartbeat_timer runs are created with no issueId/taskId in their
  // contextSnapshot (the run scratch dir is literally paperclip-run-unassigned-…).
  // Previously the gate denied every comment/update from such a run. The fix
  // resolves the source issue in descending steps and falls through to meter
  // the attempt instead of throwing when the source is unresolvable.
  const CONTEXT_LESS_RUN_OVERRIDES = { contextSnapshot: {} };

  it("treats a context-less run writing to its own assigned issue as a self-write (unmetered)", async () => {
    const fake = counterDb({
      runOverrides: CONTEXT_LESS_RUN_OVERRIDES,
      targetIssue: { assigneeAgentId: ACTING_AGENT_ID },
    });

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: COMPANY_ID,
      runId: RUN_ID,
      agentId: ACTING_AGENT_ID,
      targetIssueId: TARGET_ISSUE_ID,
      kind: "comment",
    })).resolves.toBeNull();
    expect(fake.inserted).toEqual([]);
  });

  it("meters a foreign cross-issue write from a context-less run with sourceIssueId null", async () => {
    const fake = counterDb({
      runOverrides: CONTEXT_LESS_RUN_OVERRIDES,
      // No checkoutRunId/executionRunId match and the target is not assigned
      // to the acting agent, so step-3 also falls through.
    });

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: COMPANY_ID,
      runId: RUN_ID,
      agentId: ACTING_AGENT_ID,
      targetIssueId: TARGET_ISSUE_ID,
      kind: "update",
      now: new Date(CROSS_ISSUE_INFLUENCE_ENFORCE_AT.getTime() - 1),
    })).resolves.toMatchObject({ allowed: true, count: 1 });

    expect(fake.inserted).toEqual([
      expect.objectContaining({
        action: "issue.cross_issue_influence_observed",
        runId: RUN_ID,
        details: expect.objectContaining({
          kind: "update",
          sourceIssueId: null,
          targetIssueId: TARGET_ISSUE_ID,
          count: 1,
          allowed: true,
        }),
      }),
    ]);
  });

  it("still hard-fails the cap on a context-less run after the enforcement flip", async () => {
    // Pre-existing observations for this runId have already burned the budget;
    // the next foreign write must be rejected, not silently allowed.
    const fake = counterDb({
      initialCount: CROSS_ISSUE_INFLUENCE_LIMIT,
      runOverrides: CONTEXT_LESS_RUN_OVERRIDES,
    });

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: COMPANY_ID,
      runId: RUN_ID,
      agentId: ACTING_AGENT_ID,
      targetIssueId: TARGET_ISSUE_ID,
      kind: "update",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toMatchObject({
      allowed: false,
      mode: "enforce",
      count: CROSS_ISSUE_INFLUENCE_LIMIT + 1,
      cap: CROSS_ISSUE_INFLUENCE_LIMIT,
    });

    expect(fake.inserted).toEqual([
      expect.objectContaining({
        action: "issue.cross_issue_influence_cap_rejected",
        runId: RUN_ID,
        details: expect.objectContaining({
          sourceIssueId: null,
          targetIssueId: TARGET_ISSUE_ID,
          count: CROSS_ISSUE_INFLUENCE_LIMIT + 1,
          allowed: false,
        }),
      }),
    ]);
  });

  it("uses the issue checked out by a context-less run as its source", async () => {
    const checkoutIssueId = "77777777-7777-4777-8777-777777777777";
    const otherIssueId = "88888888-8888-4888-8888-888888888888";
    const fake = counterDb({
      runOverrides: CONTEXT_LESS_RUN_OVERRIDES,
      checkoutIssue: { id: checkoutIssueId },
    });

    // Foreign write: the checked-out issue becomes the source, and the
    // activity row records it as sourceIssueId.
    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: COMPANY_ID,
      runId: RUN_ID,
      agentId: ACTING_AGENT_ID,
      targetIssueId: otherIssueId,
      kind: "comment",
      now: new Date(CROSS_ISSUE_INFLUENCE_ENFORCE_AT.getTime() - 1),
    })).resolves.toMatchObject({ allowed: true, count: 1 });

    expect(fake.inserted).toEqual([
      expect.objectContaining({
        action: "issue.cross_issue_influence_observed",
        details: expect.objectContaining({
          sourceIssueId: checkoutIssueId,
          targetIssueId: otherIssueId,
        }),
      }),
    ]);

    // Same-target short-circuit: targeting the checked-out issue itself must
    // resolve to null (unmetered), mirroring the source===target rule.
    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: COMPANY_ID,
      runId: RUN_ID,
      agentId: ACTING_AGENT_ID,
      targetIssueId: checkoutIssueId,
      kind: "comment",
      now: new Date(CROSS_ISSUE_INFLUENCE_ENFORCE_AT.getTime() - 1),
    })).resolves.toBeNull();
  });
});