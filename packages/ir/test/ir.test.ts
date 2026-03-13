import { describe, expect, it } from "vitest";

import { packageName } from "../src/index.ts";

describe("@jplmm/ir", () => {
  it("exports its package identity", () => {
    expect(packageName).toBe("@jplmm/ir");
  });
});
