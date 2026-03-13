import { spawnSync } from "node:child_process";
export const INT32_MIN = -2147483648;
export const INT32_MAX = 2147483647;
const Z3_PATH = "z3";
export function buildZ3BasePrelude() {
    return [
        "(set-logic ALL)",
        "(set-option :pp.decimal true)",
    ];
}
export function buildJplInt32Prelude() {
    return [
        ...buildZ3BasePrelude(),
        `(define-fun clamp_int ((x Int)) Int (ite (< x ${INT32_MIN}) ${INT32_MIN} (ite (> x ${INT32_MAX}) ${INT32_MAX} x)))`,
        "(define-fun abs_int ((x Int)) Int (ite (< x 0) (- x) x))",
        "(define-fun max_int ((a Int) (b Int)) Int (ite (< a b) b a))",
        "(define-fun min_int ((a Int) (b Int)) Int (ite (< a b) a b))",
        "(define-fun positive_extent_int ((x Int)) Int (max_int 1 (clamp_int x)))",
        "(define-fun clamp_range_int ((x Int) (lo Int) (hi Int)) Int (min_int (max_int x lo) hi))",
        "(define-fun clamp_index_int ((idx Int) (dim Int)) Int (ite (<= dim 1) 0 (let ((sidx (clamp_int idx))) (ite (< sidx 0) 0 (ite (>= sidx dim) (- dim 1) sidx)))))",
        "(define-fun sat_add_int ((a Int) (b Int)) Int (clamp_int (+ a b)))",
        "(define-fun sat_sub_int ((a Int) (b Int)) Int (clamp_int (- a b)))",
        "(define-fun sat_mul_int ((a Int) (b Int)) Int (clamp_int (* a b)))",
        "(define-fun sat_neg_int ((a Int)) Int (clamp_int (- a)))",
        "(define-fun trunc_div_int ((a Int) (b Int)) Int (ite (= b 0) 0 (let ((q (div (abs_int a) (abs_int b)))) (ite (= (< a 0) (< b 0)) q (- q)))))",
        "(define-fun total_div_int ((a Int) (b Int)) Int (ite (= b 0) 0 (trunc_div_int a b)))",
        "(define-fun total_mod_int ((a Int) (b Int)) Int (ite (= b 0) 0 (- a (* b (trunc_div_int a b)))))",
    ];
}
export function buildJplScalarPrelude() {
    return [
        ...buildZ3BasePrelude(),
        "(define-fun abs_int ((x Int)) Int (ite (< x 0) (- x) x))",
        "(define-fun abs_real ((x Real)) Real (ite (< x 0.0) (- x) x))",
        "(define-fun max_int ((a Int) (b Int)) Int (ite (< a b) b a))",
        "(define-fun min_int ((a Int) (b Int)) Int (ite (< a b) a b))",
        "(define-fun clamp_int ((x Int) (lo Int) (hi Int)) Int (min_int (max_int x lo) hi))",
        `(define-fun clamp_int32 ((x Int)) Int (clamp_int x ${INT32_MIN} ${INT32_MAX}))`,
        "(define-fun positive_extent_int ((x Int)) Int (max_int 1 (clamp_int32 x)))",
        "(define-fun clamp_index_int ((idx Int) (dim Int)) Int (ite (<= dim 1) 0 (let ((sidx (clamp_int32 idx))) (ite (< sidx 0) 0 (ite (>= sidx dim) (- dim 1) sidx)))))",
        "(define-fun sat_add_int ((a Int) (b Int)) Int (clamp_int32 (+ a b)))",
        "(define-fun sat_sub_int ((a Int) (b Int)) Int (clamp_int32 (- a b)))",
        "(define-fun sat_mul_int ((a Int) (b Int)) Int (clamp_int32 (* a b)))",
        "(define-fun sat_neg_int ((a Int)) Int (clamp_int32 (- a)))",
        "(define-fun max_real ((a Real) (b Real)) Real (ite (< a b) b a))",
        "(define-fun min_real ((a Real) (b Real)) Real (ite (< a b) a b))",
        "(define-fun clamp_real ((x Real) (lo Real) (hi Real)) Real (min_real (max_real x lo) hi))",
        "(define-fun trunc_div_int ((a Int) (b Int)) Int (ite (= b 0) 0 (let ((q (div (abs_int a) (abs_int b)))) (ite (= (< a 0) (< b 0)) q (- q)))))",
        "(define-fun total_div_int ((a Int) (b Int)) Int (ite (= b 0) 0 (trunc_div_int a b)))",
        "(define-fun total_mod_int ((a Int) (b Int)) Int (ite (= b 0) 0 (- a (* b (trunc_div_int a b)))))",
        "(define-fun total_div_real ((a Real) (b Real)) Real (ite (= b 0.0) 0.0 (/ a b)))",
        "(define-fun trunc_real ((x Real)) Int (ite (>= x 0.0) (to_int x) (- (to_int (- x)))))",
        `(define-fun to_int_real ((x Real)) Int (clamp_int (trunc_real x) ${INT32_MIN} ${INT32_MAX}))`,
    ];
}
export function sanitizeSymbol(name) {
    return name.replace(/[^A-Za-z0-9_]/g, "_");
}
export function checkSat(lines) {
    const result = runZ3(lines, ["(check-sat)"]);
    if (!result.ok) {
        return result;
    }
    return {
        ok: true,
        output: result.output,
        status: classifyZ3Output(result.output),
    };
}
export function checkSatAndGetValues(lines, symbols) {
    if (symbols.length === 0) {
        const result = checkSat(lines);
        if (!result.ok) {
            return result;
        }
        return {
            ok: true,
            output: result.output,
            status: result.status,
            values: result.status === "sat" ? new Map() : null,
        };
    }
    const result = runZ3(lines, [
        "(check-sat)",
        `(get-value (${symbols.join(" ")}))`,
    ]);
    if (!result.ok) {
        return result;
    }
    const status = classifyZ3Output(result.output);
    return {
        ok: true,
        output: result.output,
        status,
        values: status === "sat" ? parseGetValueOutput(result.output) : null,
    };
}
export function parseGetValueOutput(output) {
    const start = output.indexOf("((");
    if (start < 0) {
        return null;
    }
    const parsed = parseSExpr(output.slice(start));
    if (!parsed || !Array.isArray(parsed)) {
        return null;
    }
    const values = new Map();
    for (const entry of parsed) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
            continue;
        }
        values.set(entry[0], renderSExpr(entry[1]));
    }
    return values;
}
export function parseZ3Int(value) {
    if (/^-?\d+$/.test(value)) {
        return Number(value);
    }
    const neg = /^\(-\s+(\d+)\)$/.exec(value);
    if (neg) {
        return -Number(neg[1]);
    }
    return null;
}
function runZ3(lines, commands) {
    const result = spawnSync(Z3_PATH, ["-in"], {
        input: `${[...lines, ...commands].join("\n")}\n`,
        encoding: "utf8",
    });
    if (result.error) {
        return {
            ok: false,
            error: result.error.message,
        };
    }
    return {
        ok: true,
        output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim(),
    };
}
function classifyZ3Output(output) {
    if (output.startsWith("unsat")) {
        return "unsat";
    }
    if (output.startsWith("sat")) {
        return "sat";
    }
    if (output.startsWith("unknown")) {
        return "unknown";
    }
    return "other";
}
function parseSExpr(source) {
    const tokens = tokenizeSExpr(source);
    let idx = 0;
    function parse() {
        const token = tokens[idx];
        if (!token) {
            return null;
        }
        if (token === "(") {
            idx += 1;
            const items = [];
            while (idx < tokens.length && tokens[idx] !== ")") {
                const item = parse();
                if (item === null) {
                    return null;
                }
                items.push(item);
            }
            if (tokens[idx] !== ")") {
                return null;
            }
            idx += 1;
            return items;
        }
        if (token === ")") {
            return null;
        }
        idx += 1;
        return token;
    }
    return parse();
}
function tokenizeSExpr(source) {
    const tokens = [];
    let current = "";
    for (const char of source) {
        if (char === "(" || char === ")") {
            if (current.length > 0) {
                tokens.push(current);
                current = "";
            }
            tokens.push(char);
            continue;
        }
        if (/\s/.test(char)) {
            if (current.length > 0) {
                tokens.push(current);
                current = "";
            }
            continue;
        }
        current += char;
    }
    if (current.length > 0) {
        tokens.push(current);
    }
    return tokens;
}
function renderSExpr(expr) {
    if (typeof expr === "string") {
        return expr;
    }
    if (expr.length === 2 && expr[0] === "-") {
        return `-${renderSExpr(expr[1])}`;
    }
    if (expr.length === 3 && typeof expr[0] === "string" && ["+", "-", "*", "/"].includes(expr[0])) {
        return `${renderSExpr(expr[1])} ${expr[0]} ${renderSExpr(expr[2])}`;
    }
    return `(${expr.map((item) => renderSExpr(item)).join(" ")})`;
}
//# sourceMappingURL=index.js.map