import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnSync } = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawnSync,
}));

import { checkSat, withHardTimeout } from "../src/index";

describe("@jplmm/smt timeouts", () => {
  beforeEach(() => {
    spawnSync.mockReset();
  });

  it("passes timeout and kill settings to z3", () => {
    spawnSync.mockReturnValue({
      stdout: "unsat\n",
      stderr: "",
    });

    const result = checkSat(["(declare-const x Int)"], { timeoutMs: 123 });
    expect(result.ok).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith("z3", ["-in"], expect.objectContaining({
      timeout: 373,
      killSignal: "SIGKILL",
    }));
  });

  it("reports solver timeouts distinctly", () => {
    const error = Object.assign(new Error("spawnSync z3 ETIMEDOUT"), { code: "ETIMEDOUT" });
    spawnSync.mockReturnValue({
      error,
      stdout: "",
      stderr: "",
    });

    const result = checkSat([], { timeoutMs: 9 });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("timed out after 9ms");
  });

  it("reuses the remaining proof deadline across chained solver calls", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));
    spawnSync.mockReturnValue({
      stdout: "unsat\n",
      stderr: "",
    });

    const options = withHardTimeout({ timeoutMs: 2000 });
    vi.setSystemTime(new Date("2026-03-13T00:00:01.950Z"));
    const result = checkSat(["(declare-const x Int)"], options);

    expect(result.ok).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith("z3", ["-in"], expect.objectContaining({
      timeout: 300,
      killSignal: "SIGKILL",
    }));
    vi.useRealTimers();
  });

  it("fails fast when the shared proof deadline is already exhausted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));
    const options = withHardTimeout({ timeoutMs: 25 });

    vi.setSystemTime(new Date("2026-03-13T00:00:01.000Z"));
    const result = checkSat(["(declare-const x Int)"], options);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("timed out after 25ms");
    expect(spawnSync).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
