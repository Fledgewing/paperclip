import { describe, expect, it } from "vitest";
import {
  RECOVERY_STAGE_FAILURE_ESCALATION_THRESHOLD,
  buildRecoveryStageStuckIssueMarkdown,
  createRecoveryStageEscalator,
  createRecoveryStageRunner,
  type RecoveryStageResults,
  type RecoveryStageHealth,
  type RecoveryStageEscalationPorts,
} from "./stage-runner.js";

function makeLogger() {
  const errors: Array<{ obj: unknown; msg?: string }> = [];
  const warnings: Array<{ obj: unknown; msg?: string }> = [];
  return {
    errors,
    warnings,
    logger: {
      info: () => {},
      warn: (obj?: unknown, msg?: string) => warnings.push({ obj, msg }),
      error: (obj?: unknown, msg?: string) => errors.push({ obj, msg }),
    },
  };
}

function recoveryStage(stage: string, overrides: Partial<RecoveryStageHealth> = {}): RecoveryStageHealth {
  return {
    stage,
    lastSuccessAt: null,
    lastFailureAt: new Date("2026-09-16T00:00:00.000Z"),
    firstFailureAt: new Date("2026-09-16T00:00:00.000Z"),
    consecutiveFailures: RECOVERY_STAGE_FAILURE_ESCALATION_THRESHOLD,
    lastErrorMessage: "boom",
    escalated: false,
    ...overrides,
  };
}

const STAGE_NAMES = [
  "reapOrphanedRuns",
  "promoteDueScheduledRetries",
  "resumeQueuedRuns",
  "reconcileResolvedDependencyWakes",
  "reconcileTaskWatchdogs",
  "scanSilentActiveRuns",
  "sweepStaleIssueLocks",
  "reconcileProductivityReviews",
] as const;

describe("createRecoveryStageRunner", () => {
  it("isolates a throwing stage: every later stage still runs, in order", async () => {
    const executed: string[] = [];
    const { logger, errors } = makeLogger();
    const runner = createRecoveryStageRunner({
      logger,
      stages: STAGE_NAMES.map((name) => ({
        name,
        run: async () => {
          executed.push(name);
          if (name === "reconcileResolvedDependencyWakes") {
            throw new Error("blocking-cycle 422");
          }
          return `${name}-ok`;
        },
      })),
    });

    const results = await runner.runOnce();

    expect(executed).toEqual([...STAGE_NAMES]);
    expect(results.get("reconcileResolvedDependencyWakes")).toBeUndefined();
    expect(results.get("reconcileProductivityReviews")).toBe("reconcileProductivityReviews-ok");

    const failure = runner.getStageHealth("reconcileResolvedDependencyWakes")!;
    expect(failure.consecutiveFailures).toBe(1);
    expect(failure.lastErrorMessage).toBe("blocking-cycle 422");
    expect(failure.lastSuccessAt).toBeNull();

    const survivor = runner.getStageHealth("reconcileProductivityReviews")!;
    expect(survivor.consecutiveFailures).toBe(0);
    expect(survivor.lastSuccessAt).toBeInstanceOf(Date);

    const logged = errors.find(
      (entry) => entry.msg === "heartbeat recovery stage failed",
    );
    expect(logged).toBeDefined();
    expect(logged!.obj).toMatchObject({ stage: "reconcileResolvedDependencyWakes" });
  });

  it("passes earlier stage results to dependent stages and degrades when the producer failed", async () => {
    const { logger } = makeLogger();
    const seenPromotion: unknown[] = [];
    const stages = [
      {
        name: "reapOrphanedRuns",
        run: async () => "reaped",
      },
      {
        name: "promoteDueScheduledRetries",
        run: async () => ({ promoted: 2, runIds: ["r1", "r2"] }),
      },
      {
        name: "resumeQueuedRuns",
        run: async (results: RecoveryStageResults) => {
          seenPromotion.push(results.get("promoteDueScheduledRetries"));
          return "resumed";
        },
      },
    ];
    const runner = createRecoveryStageRunner({ logger, stages });
    await runner.runOnce();
    expect(seenPromotion[0]).toEqual({ promoted: 2, runIds: ["r1", "r2"] });

    // When stage 2 throws, the coupled stage still runs with an undefined
    // producer result so the wiring falls back to zero-promotion logging.
    const producerFailed = createRecoveryStageRunner({
      logger,
      stages: [
        { name: "promoteDueScheduledRetries", run: async () => { throw new Error("promote failed"); } },
        {
          name: "resumeQueuedRuns",
          run: async (results) => {
            seenPromotion.push(results.get("promoteDueScheduledRetries"));
            return "resumed";
          },
        },
      ],
    });
    await producerFailed.runOnce();
    expect(seenPromotion[1]).toBeUndefined();
    expect(producerFailed.getStageHealth("resumeQueuedRuns")!.lastSuccessAt).toBeInstanceOf(Date);
  });

  it("does not escalate below the threshold and survives transient failures", async () => {
    const { logger } = makeLogger();
    const escalations: RecoveryStageHealth[] = [];
    let tick = 0;
    let recoveredOnce = false;
    const runner = createRecoveryStageRunner({
      logger,
      stages: [{
        name: "sweepStaleIssueLocks",
        run: async () => {
          tick += 1;
          if (tick === 5) { recoveredOnce = true; return "ok"; }
          throw new Error("transient");
        },
      }],
      escalate: async (stage) => { escalations.push(stage); },
    });

    for (let i = 0; i < 9; i += 1) await runner.runOnce();
    // Four failures, then success, then four failures: no escalation, the
    // success between the two bursts resets the consecutive counter.
    expect(recoveredOnce).toBe(true);
    expect(escalations).toHaveLength(0);
    expect(runner.getStageHealth("sweepStaleIssueLocks")!.consecutiveFailures).toBe(4);
  });

  it("escalates exactly once when consecutive failures cross the threshold, never repeats while stuck", async () => {
    const { logger } = makeLogger();
    const escalations: RecoveryStageHealth[] = [];
    let alwaysFail = true;
    const runner = createRecoveryStageRunner({
      logger,
      stages: [{
        name: "reconcileStrandedAssignedIssues",
        run: async () => {
          if (alwaysFail) throw new Error("http 422 cycle");
          return "ok";
        },
      }],
      escalate: async (stage) => { escalations.push(stage); },
    });

    for (let i = 0; i < RECOVERY_STAGE_FAILURE_ESCALATION_THRESHOLD - 1; i += 1) {
      await runner.runOnce();
    }
    expect(escalations).toHaveLength(0);

    await runner.runOnce();
    expect(escalations).toHaveLength(1);
    expect(escalations[0].stage).toBe("reconcileStrandedAssignedIssues");
    expect(escalations[0].consecutiveFailures).toBe(RECOVERY_STAGE_FAILURE_ESCALATION_THRESHOLD);
    expect(escalations[0].lastErrorMessage).toBe("http 422 cycle");

    // 100 more failing ticks: the stage stays stuck, still exactly one escalation.
    for (let i = 0; i < 100; i += 1) await runner.runOnce();
    expect(escalations).toHaveLength(1);
    expect(runner.getStageHealth("reconcileStrandedAssignedIssues")!.consecutiveFailures)
      .toBe(RECOVERY_STAGE_FAILURE_ESCALATION_THRESHOLD + 100);

    // Recovery releases the latch; the next stuck episode escalates again.
    alwaysFail = false;
    await runner.runOnce();
    expect(runner.getStageHealth("reconcileStrandedAssignedIssues")!.consecutiveFailures).toBe(0);
    alwaysFail = true;
    for (let i = 0; i < RECOVERY_STAGE_FAILURE_ESCALATION_THRESHOLD; i += 1) {
      await runner.runOnce();
    }
    expect(escalations).toHaveLength(2);
  });

  it("releases the escalation latch for retry when the escalation itself throws", async () => {
    const { logger, errors } = makeLogger();
    let attempts = 0;
    const runner = createRecoveryStageRunner({
      logger,
      stages: [{ name: "scanSilentActiveRuns", run: async () => { throw new Error("dead"); } }],
      escalate: async () => { attempts += 1; throw new Error("ceo unresolvable"); },
    });
    for (let i = 0; i < RECOVERY_STAGE_FAILURE_ESCALATION_THRESHOLD + 2; i += 1) {
      await runner.runOnce();
    }
    expect(attempts).toBeGreaterThan(1);
    expect(errors.some((e) => e.msg === "recovery stage escalation failed")).toBe(true);
  });

  it("rejects duplicate stage names at construction", () => {
    const { logger } = makeLogger();
    expect(() =>
      createRecoveryStageRunner({
        logger,
        stages: [
          { name: "dup", run: async () => 1 },
          { name: "dup", run: async () => 2 },
        ],
      }),
    ).toThrow(/duplicate recovery stage name/);
  });
});

function makeFakeEscalationPorts() {
  const state = {
    openIssues: new Map<string, { id: string; status: string; description: string }>(),
    creates: [] as Array<{ title: string; assigneeAgentId: string; description: string; idempotencyKey: string }>,
    updates: [] as Array<{ issueId: string; description: string }>,
    wakes: [] as Array<{ issueId: string; stage: string }>,
    nextId: 1,
    companyId: "company-1",
    ceoResolvable: true,
  };
  const ports: RecoveryStageEscalationPorts = {
    findCompanyIdForAgent: async () => (state.ceoResolvable ? state.companyId : null),
    findOpenIssueByTitle: async (companyId, title) => {
      if (companyId !== state.companyId) return null;
      const normalized = title.trim().replace(/\s+/g, " ").toLowerCase();
      for (const [key, issue] of state.openIssues) {
        const storedTitle = key.split("|")[1]!;
        if (storedTitle === normalized && issue.status !== "done" && issue.status !== "cancelled") {
          return { id: issue.id, status: issue.status };
        }
      }
      return null;
    },
    createIssue: async (companyId, input) => {
      if (companyId !== state.companyId) throw new Error("wrong company");
      const normalized = input.title.trim().replace(/\s+/g, " ").toLowerCase();
      const dedupeKey = `${companyId}|${normalized}`;
      const existing = state.openIssues.get(dedupeKey);
      if (existing && existing.status !== "done" && existing.status !== "cancelled") {
        return { id: existing.id, assigneeAgentId: input.assigneeAgentId, status: existing.status };
      }
      const id = `issue-${state.nextId++}`;
      state.openIssues.set(dedupeKey, { id, status: "todo", description: input.description });
      state.creates.push({ title: input.title, assigneeAgentId: input.assigneeAgentId, description: input.description, idempotencyKey: input.idempotencyKey });
      return { id, assigneeAgentId: input.assigneeAgentId, status: "todo" };
    },
    updateIssue: async (issueId, input) => {
      state.updates.push({ issueId, description: input.description });
      for (const issue of state.openIssues.values()) {
        if (issue.id === issueId) issue.description = input.description;
      }
    },
    wakeAssignee: async (issue, stage) => {
      state.wakes.push({ issueId: issue.id, stage });
    },
  };
  return { ports, state };
}

describe("createRecoveryStageEscalator", () => {
  it("creates exactly one issue across a persistently-failing stage and updates in place later", async () => {
    const { logger } = makeLogger();
    const { ports, state } = makeFakeEscalationPorts();
    const escalate = createRecoveryStageEscalator({
      ceoAgentId: "ceo-agent",
      ports,
      logger,
    });
    const runner = createRecoveryStageRunner({
      logger,
      stages: [{ name: "reconcileStrandedAssignedIssues", run: async () => { throw new Error("http 422 cycle"); } }],
      escalate: async (health) => { await escalate(health); },
    });

    for (let i = 0; i < RECOVERY_STAGE_FAILURE_ESCALATION_THRESHOLD + 5; i += 1) {
      await runner.runOnce();
    }
    expect(state.creates).toHaveLength(1);
    expect(state.creates[0].title).toBe("Recovery stage stuck: reconcileStrandedAssignedIssues");
    expect(state.creates[0].assigneeAgentId).toBe("ceo-agent");
    expect(state.updates).toHaveLength(0);
    expect(state.wakes).toHaveLength(1);
  });

  it("re-escalation while the stuck-stage issue is still open updates it instead of duplicating", async () => {
    const { logger } = makeLogger();
    const { ports, state } = makeFakeEscalationPorts();
    const escalate = createRecoveryStageEscalator({
      ceoAgentId: "ceo-agent",
      ports,
      logger,
    });

    const first = await escalate(recoveryStage("reconcileTaskWatchdogs"));
    expect(first.kind).toBe("created");
    // Stage recovers, then gets stuck again while the original issue is open.
    const second = await escalate(recoveryStage("reconcileTaskWatchdogs", {
      consecutiveFailures: 12,
      lastErrorMessage: "http 500 db down",
    }));
    expect(second.kind).toBe("updated");
    if (second.kind !== "updated") throw new Error("expected update");
    expect(second.issueId).toBe((first as { issueId: string }).issueId);
    expect(state.creates).toHaveLength(1);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].description).toContain("http 500 db down");

    // Once the CEO closes the issue, a new episode creates a fresh issue.
    const openEntry = [...state.openIssues.values()][0]!;
    openEntry.status = "done";
    const third = await escalate(recoveryStage("reconcileTaskWatchdogs", {
      consecutiveFailures: 10,
      lastErrorMessage: "http 422 cycle",
    }));
    expect(third.kind).toBe("created");
    expect(state.creates).toHaveLength(2);
  });

  it("skips escalation with a loud log when the CEO agent cannot be resolved", async () => {
    const { logger, errors } = makeLogger();
    const { ports, state } = makeFakeEscalationPorts();
    state.ceoResolvable = false;
    const escalate = createRecoveryStageEscalator({ ceoAgentId: "missing-ceo", ports, logger });
    const result = await escalate(recoveryStage("scanSilentActiveRuns"));
    expect(result.kind).toBe("skipped");
    expect(state.creates).toHaveLength(0);
    expect(errors.some((e) => (e.obj as { ceoAgentId?: string }).ceoAgentId === "missing-ceo")).toBe(true);
  });

  it("carries stage, consecutive count, lastSuccessAt and error message in the issue body", () => {
    const body = buildRecoveryStageStuckIssueMarkdown(recoveryStage("sweepStaleIssueLocks", {
      consecutiveFailures: 10,
      lastSuccessAt: new Date("2026-09-15T04:00:00.000Z"),
      lastErrorMessage: "HttpError 422: Blocking relations cannot contain cycles",
    }));
    expect(body).toContain("sweepStaleIssueLocks");
    expect(body).toContain("Consecutive failures: 10");
    expect(body).toContain("2026-09-15T04:00:00.000Z");
    expect(body).toContain("Blocking relations cannot contain cycles");
  });
});
