import { describe, expect, it } from "vitest";

import type { Program } from "@jplmm/ast";

import { buildIR } from "../src/builder.ts";

const INT = { tag: "int" } as const;

describe("buildIR", () => {
  it("marks direct rec in return position as tail-position", () => {
    const program: Program = {
      commands: [
        {
          tag: "fn_def",
          name: "f",
          params: [{ name: "x", type: INT }],
          retType: INT,
          body: [
            { tag: "ret", expr: { tag: "var", name: "x", id: 1 }, id: 2 },
            {
              tag: "ret",
              expr: {
                tag: "rec",
                args: [
                  {
                    tag: "binop",
                    op: "-",
                    left: { tag: "var", name: "x", id: 3 },
                    right: { tag: "int_lit", value: 1, id: 4 },
                    id: 5,
                  },
                ],
                id: 6,
              },
              id: 7,
            },
            { tag: "rad", expr: { tag: "var", name: "x", id: 8 }, id: 9 },
          ],
          id: 10,
        },
      ],
    };

    const ir = buildIR(program);
    const fn = ir.functions[0];
    expect(fn?.body[1]?.tag).toBe("ret");
    if (fn?.body[1]?.tag === "ret") {
      expect(fn.body[1].expr.tag).toBe("rec");
      if (fn.body[1].expr.tag === "rec") {
        expect(fn.body[1].expr.tailPosition).toBe(true);
      }
    }
  });

  it("marks nested rec as non-tail", () => {
    const program: Program = {
      commands: [
        {
          tag: "fn_def",
          name: "g",
          params: [{ name: "x", type: INT }],
          retType: INT,
          body: [
            { tag: "ret", expr: { tag: "var", name: "x", id: 1 }, id: 2 },
            {
              tag: "ret",
              expr: {
                tag: "binop",
                op: "+",
                left: {
                  tag: "rec",
                  args: [
                    {
                      tag: "binop",
                      op: "-",
                      left: { tag: "var", name: "x", id: 3 },
                      right: { tag: "int_lit", value: 1, id: 4 },
                      id: 5,
                    },
                  ],
                  id: 6,
                },
                right: { tag: "int_lit", value: 1, id: 7 },
                id: 8,
              },
              id: 9,
            },
            { tag: "rad", expr: { tag: "var", name: "x", id: 10 }, id: 11 },
          ],
          id: 12,
        },
      ],
    };

    const ir = buildIR(program);
    const fn = ir.functions[0];
    expect(fn?.body[1]?.tag).toBe("ret");
    if (fn?.body[1]?.tag === "ret" && fn.body[1].expr.tag === "binop") {
      expect(fn.body[1].expr.left.tag).toBe("rec");
      if (fn.body[1].expr.left.tag === "rec") {
        expect(fn.body[1].expr.left.tailPosition).toBe(false);
      }
    }
  });

  it("lowers top-level lets into IR globals", () => {
    const program: Program = {
      commands: [
        {
          tag: "let_cmd",
          lvalue: { tag: "var", name: "a" },
          expr: { tag: "int_lit", value: 5, id: 1 },
          id: 2,
        },
      ],
    };
    const ir = buildIR(program);
    expect(ir.functions).toHaveLength(0);
    expect(ir.globals).toHaveLength(1);
    expect(ir.globals[0]?.name).toBe("a");
  });

  it("carries struct defs and lowers comprehension scopes into IR", () => {
    const program: Program = {
      commands: [
        {
          tag: "struct_def",
          name: "Pair",
          fields: [
            { name: "left", type: INT },
            { name: "right", type: INT },
          ],
          id: 1,
        },
        {
          tag: "fn_def",
          name: "grid",
          params: [{ name: "n", type: INT }],
          retType: { tag: "array", element: INT, dims: 2 },
          body: [
            {
              tag: "ret",
              expr: {
                tag: "array_expr",
                bindings: [
                  { name: "i", expr: { tag: "var", name: "n", id: 2 } },
                  {
                    name: "j",
                    expr: {
                      tag: "binop",
                      op: "+",
                      left: { tag: "var", name: "i", id: 3 },
                      right: { tag: "int_lit", value: 1, id: 4 },
                      id: 5,
                    },
                  },
                ],
                body: {
                  tag: "binop",
                  op: "+",
                  left: { tag: "var", name: "i", id: 6 },
                  right: { tag: "var", name: "j", id: 7 },
                  id: 8,
                },
                id: 9,
              },
              id: 10,
            },
          ],
          id: 11,
        },
      ],
    };

    const ir = buildIR(program);
    expect(ir.structs).toHaveLength(1);
    expect(ir.structs[0]?.name).toBe("Pair");
    const fn = ir.functions[0];
    expect(fn?.body[0]?.tag).toBe("ret");
    if (fn?.body[0]?.tag === "ret") {
      expect(fn.body[0].expr.tag).toBe("array_expr");
      if (fn.body[0].expr.tag === "array_expr") {
        expect(fn.body[0].expr.bindings[1]?.expr.tag).toBe("binop");
      }
    }
  });

  it("lowers struct field let-targets by rebuilding the struct", () => {
    const program: Program = {
      commands: [
        {
          tag: "struct_def",
          name: "Pair",
          fields: [
            { name: "left", type: INT },
            { name: "right", type: INT },
          ],
          id: 1,
        },
        {
          tag: "fn_def",
          name: "bump",
          params: [{ name: "p", type: { tag: "named", name: "Pair" } }],
          retType: { tag: "named", name: "Pair" },
          body: [
            {
              tag: "let",
              lvalue: { tag: "field", base: "p", field: "right" },
              expr: { tag: "int_lit", value: 7, id: 2 },
              id: 3,
            },
            {
              tag: "ret",
              expr: { tag: "var", name: "p", id: 4 },
              id: 5,
            },
          ],
          id: 6,
        },
      ],
    };

    const ir = buildIR(program);
    const fn = ir.functions[0];
    expect(fn?.body[0]?.tag).toBe("let");
    if (fn?.body[0]?.tag === "let") {
      expect(fn.body[0].name).toBe("p");
      expect(fn.body[0].expr.tag).toBe("struct_cons");
    }
  });
});
