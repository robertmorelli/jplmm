import { describe, expect, it } from "vitest";

import type { Cmd, Expr, GasLimit, Program, Type } from "../src";

describe("ast types", () => {
  it("supports array type ranks", () => {
    const t: Type = {
      tag: "array",
      element: { tag: "float" },
      dims: 2,
    };
    expect(t.tag).toBe("array");
    if (t.tag === "array") {
      expect(t.dims).toBe(2);
      expect(t.element.tag).toBe("float");
    }
  });

  it("represents recursive expressions with ids", () => {
    const e: Expr = {
      tag: "rec",
      args: [
        {
          tag: "binop",
          op: "-",
          left: { tag: "var", name: "x", id: 1 },
          right: { tag: "int_lit", value: 1, id: 2 },
          id: 3,
        },
      ],
      id: 4,
    };
    expect(e.tag).toBe("rec");
    expect(e.id).toBe(4);
  });

  it("represents function commands with proof statements", () => {
    const cmd: Cmd = {
      tag: "fn_def",
      name: "decr",
      params: [{ name: "x", type: { tag: "int" } }],
      retType: { tag: "int" },
      body: [
        { tag: "ret", expr: { tag: "var", name: "x", id: 1 }, id: 2 },
        { tag: "ret", expr: { tag: "rec", args: [{ tag: "res", id: 3 }], id: 4 }, id: 5 },
        { tag: "gas", limit: 10, id: 6 },
      ],
      id: 7,
    };
    expect(cmd.tag).toBe("fn_def");
    if (cmd.tag === "fn_def") {
      expect(cmd.body.map((s) => s.tag)).toEqual(["ret", "ret", "gas"]);
    }
  });

  it("allows numeric and infinite gas limits", () => {
    const finite: GasLimit = 100;
    const infinite: GasLimit = "inf";
    expect(finite).toBe(100);
    expect(infinite).toBe("inf");
  });

  it("assembles top-level programs from commands", () => {
    const program: Program = {
      commands: [
        {
          tag: "let_cmd",
          lvalue: { tag: "var", name: "x" },
          expr: { tag: "int_lit", value: 5, id: 1 },
          id: 2,
        },
      ],
    };
    expect(program.commands).toHaveLength(1);
    expect(program.commands[0]?.tag).toBe("let_cmd");
  });
});
