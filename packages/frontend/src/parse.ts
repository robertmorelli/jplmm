import type {
  Argument,
  Binding,
  Cmd,
  Expr,
  GasLimit,
  LValue,
  Param,
  Program,
  Stmt,
  StructField,
  Type,
} from "@jplmm/ast";
import { REMOVED_KEYWORDS, tokenize, type Token } from "@jplmm/grammar";

import { error, type Diagnostic } from "./errors";

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const UINT32_MAX = 4294967296;

type ParseResult = {
  program: Program;
  diagnostics: Diagnostic[];
};

class Parser {
  private readonly tokens: Token[];
  private idx = 0;
  private nextId = 1;
  private readonly diagnostics: Diagnostic[] = [];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parseProgram(): ParseResult {
    const commands: Cmd[] = [];
    while (!this.isEof()) {
      const command = this.parseCmd();
      if (command) {
        commands.push(command);
      } else {
        const t = this.peek();
        this.diagnostics.push(error(`Unexpected token '${t.text}' at top-level`, t.start, t.end));
        this.advance();
      }
      this.acceptSymbol(";");
    }
    return { program: { commands }, diagnostics: this.diagnostics };
  }

  private parseCmd(): Cmd | null {
    if (this.acceptKeyword("fn")) {
      return this.parseFnDef();
    }
    if (this.acceptKeyword("let")) {
      return this.parseLetCmd();
    }
    if (this.acceptKeyword("struct")) {
      return this.parseStructDef();
    }
    if (this.acceptKeyword("read")) {
      return this.parseReadImageCmd();
    }
    if (this.acceptKeyword("write")) {
      return this.parseWriteImageCmd();
    }
    if (this.acceptKeyword("print")) {
      return this.parsePrintCmd();
    }
    if (this.acceptKeyword("show")) {
      return this.parseShowCmd();
    }
    if (this.acceptKeyword("time")) {
      return this.parseTimeCmd();
    }
    return null;
  }

  private parseFnDef(): Cmd {
    const name = this.expectIdent("Expected function name after 'fn'");
    this.expectSymbol("(", "Expected '(' after function name");
    const params: Param[] = [];
    if (!this.acceptSymbol(")")) {
      do {
        const paramName = this.expectIdent("Expected parameter name");
        this.expectSymbol(":", "Expected ':' after parameter name");
        const paramType = this.parseType();
        params.push({ name: paramName, type: paramType });
      } while (this.acceptSymbol(","));
      this.expectSymbol(")", "Expected ')' after parameter list");
    }

    this.expectSymbol(":", "Expected ':' before return type");
    const retType = this.parseType();
    this.expectSymbol("{", "Expected '{' to start function body");

    const body: Stmt[] = [];
    while (!this.acceptSymbol("}") && !this.isEof()) {
      const stmt = this.parseStmt();
      if (stmt) {
        body.push(stmt);
      }
      this.acceptSymbol(";");
    }

    return {
      tag: "fn_def",
      name,
      params,
      retType,
      body,
      id: this.newId(),
    };
  }

  private parseStructDef(): Cmd {
    const name = this.expectIdent("Expected struct name after 'struct'");
    this.expectSymbol("{", "Expected '{' after struct name");
    const fields: StructField[] = [];
    while (!this.acceptSymbol("}") && !this.isEof()) {
      const fieldName = this.expectIdent("Expected struct field name");
      this.expectSymbol(":", "Expected ':' after struct field name");
      fields.push({ name: fieldName, type: this.parseType() });
      if (!this.acceptSymbol(",")) {
        this.acceptSymbol(";");
      }
    }
    return { tag: "struct_def", name, fields, id: this.newId() };
  }

  private parseLetCmd(): Cmd {
    const lvalue = this.parseLValue();
    this.expectSymbol("=", "Expected '=' in top-level let command");
    const expr = this.parseExpr();
    return { tag: "let_cmd", lvalue, expr, id: this.newId() };
  }

  private parseReadImageCmd(): Cmd {
    this.expectKeyword("image", "Expected 'image' after 'read'");
    const filename = this.expectString("Expected string literal after 'read image'");
    this.expectKeyword("to", "Expected 'to' after image filename");
    const target = this.parseArgument();
    return { tag: "read_image", filename, target, id: this.newId() };
  }

  private parseWriteImageCmd(): Cmd {
    this.expectKeyword("image", "Expected 'image' after 'write'");
    const expr = this.parseExpr();
    this.expectKeyword("to", "Expected 'to' after image expression");
    const filename = this.expectString("Expected string literal after 'to'");
    return { tag: "write_image", expr, filename, id: this.newId() };
  }

  private parsePrintCmd(): Cmd {
    const message = this.expectString("Expected string literal after 'print'");
    return { tag: "print", message, id: this.newId() };
  }

  private parseShowCmd(): Cmd {
    const expr = this.parseExpr();
    return { tag: "show", expr, id: this.newId() };
  }

  private parseTimeCmd(): Cmd {
    const cmd = this.parseCmd();
    if (!cmd) {
      const t = this.peek();
      this.diagnostics.push(error("Expected a command after 'time'", t.start, t.end));
      return { tag: "print", message: "", id: this.newId() };
    }
    return { tag: "time", cmd, id: this.newId() };
  }

  private parseStmt(): Stmt | null {
    if (this.acceptKeyword("let")) {
      const lvalue = this.parseLValue();
      this.expectSymbol("=", "Expected '=' in let statement");
      const expr = this.parseExpr();
      return { tag: "let", lvalue, expr, id: this.newId() };
    }

    if (this.acceptKeyword("ret")) {
      const expr = this.parseExpr();
      return { tag: "ret", expr, id: this.newId() };
    }

    if (this.acceptKeyword("rad")) {
      const expr = this.parseExpr();
      return { tag: "rad", expr, id: this.newId() };
    }

    if (this.acceptKeyword("gas")) {
      const t = this.peek();
      let limit: GasLimit;
      if (this.acceptKeyword("inf")) {
        limit = "inf";
      } else if (t.kind === "int") {
        this.advance();
        limit = parseInt(t.text, 10);
      } else {
        this.diagnostics.push(error("Expected integer literal or 'inf' after gas", t.start, t.end));
        this.advance();
        return null;
      }
      return { tag: "gas", limit, id: this.newId() };
    }

    const t = this.peek();
    this.diagnostics.push(error(`Unexpected token '${t.text}' in function body`, t.start, t.end));
    this.advance();
    return null;
  }

  private parseType(): Type {
    const t = this.peek();
    let base: Type;
    if (this.acceptKeyword("int")) {
      base = { tag: "int" };
    } else if (this.acceptKeyword("float")) {
      base = { tag: "float" };
    } else if (this.acceptKeyword("void")) {
      base = { tag: "void" };
    } else if (t.kind === "ident") {
      this.advance();
      base = { tag: "named", name: t.text };
    } else {
      this.diagnostics.push(error("Expected a type", t.start, t.end));
      this.advance();
      return { tag: "void" };
    }

    let dims = 0;
    while (this.acceptSymbol("[")) {
      this.expectSymbol("]", "Expected ']' after '[' in array type");
      dims += 1;
    }
    if (dims > 0) {
      return { tag: "array", element: base, dims };
    }
    return base;
  }

  private parseLValue(): LValue {
    if (this.acceptSymbol("(")) {
      const items: LValue[] = [];
      if (!this.acceptSymbol(")")) {
        do {
          items.push(this.parseLValue());
        } while (this.acceptSymbol(","));
        this.expectSymbol(")", "Expected ')' after tuple lvalue");
      }
      return { tag: "tuple", items };
    }

    const name = this.expectIdent("Expected variable name");
    if (this.acceptSymbol(".")) {
      const field = this.expectIdent("Expected field name after '.'");
      return { tag: "field", base: name, field };
    }
    if (this.acceptSymbol("[")) {
      const bracket = this.tokens[this.idx - 1]!;
      this.consumeIndexSuffix();
      this.diagnostics.push(
        error(
          "Array index assignment is not part of JPL--; arrays are immutable values",
          bracket.start,
          bracket.end,
          "IMMUTABLE_LVALUE",
        ),
      );
      return { tag: "var", name };
    }
    return { tag: "var", name };
  }

  private consumeIndexSuffix(): void {
    let depth = 1;
    while (!this.isEof() && depth > 0) {
      if (this.acceptSymbol("[")) {
        depth += 1;
        continue;
      }
      if (this.acceptSymbol("]")) {
        depth -= 1;
        continue;
      }
      this.advance();
    }
  }

  private parseArgument(): Argument {
    if (this.acceptSymbol("(")) {
      const items: Argument[] = [];
      if (!this.acceptSymbol(")")) {
        do {
          items.push(this.parseArgument());
        } while (this.acceptSymbol(","));
        this.expectSymbol(")", "Expected ')' after tuple argument");
      }
      return { tag: "tuple", items };
    }
    const name = this.expectIdent("Expected variable name");
    return { tag: "var", name };
  }

  private parseExpr(): Expr {
    return this.parseAddSub();
  }

  private parseAddSub(): Expr {
    let expr = this.parseMulDiv();
    while (true) {
      if (this.acceptSymbol("+")) {
        expr = { tag: "binop", op: "+", left: expr, right: this.parseMulDiv(), id: this.newId() };
      } else if (this.acceptSymbol("-")) {
        expr = { tag: "binop", op: "-", left: expr, right: this.parseMulDiv(), id: this.newId() };
      } else {
        break;
      }
    }
    return expr;
  }

  private parseMulDiv(): Expr {
    let expr = this.parseUnary();
    while (true) {
      if (this.acceptSymbol("*")) {
        expr = { tag: "binop", op: "*", left: expr, right: this.parseUnary(), id: this.newId() };
      } else if (this.acceptSymbol("/")) {
        expr = { tag: "binop", op: "/", left: expr, right: this.parseUnary(), id: this.newId() };
      } else if (this.acceptSymbol("%")) {
        expr = { tag: "binop", op: "%", left: expr, right: this.parseUnary(), id: this.newId() };
      } else {
        break;
      }
    }
    return expr;
  }

  private parseUnary(): Expr {
    if (this.acceptSymbol("-")) {
      const next = this.peek();
      if (next.kind === "int") {
        this.advance();
        const value = parseInt(next.text, 10);
        if (!Number.isSafeInteger(value) || value > UINT32_MAX / 2) {
          this.diagnostics.push(error("Integer literal out of 32-bit range", next.start, next.end));
        }
        if (value === UINT32_MAX / 2) {
          return { tag: "int_lit", value: INT32_MIN, id: this.newId() };
        }
        return { tag: "int_lit", value: -value, id: this.newId() };
      }
      if (next.kind === "float") {
        this.advance();
        const value = parseFloat(next.text);
        if (!Number.isFinite(Math.fround(-value))) {
          this.diagnostics.push(error("Float literal out of 32-bit range", next.start, next.end, "FLOAT_RANGE"));
        }
        return { tag: "float_lit", value: -value, id: this.newId() };
      }
      return { tag: "unop", op: "-", operand: this.parseUnary(), id: this.newId() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    while (true) {
      if (this.acceptSymbol(".")) {
        const field = this.expectIdent("Expected field name after '.'");
        expr = { tag: "field", target: expr, field, id: this.newId() };
        continue;
      }
      if (this.acceptSymbol("[")) {
        const indices: Expr[] = [];
        if (!this.acceptSymbol("]")) {
          do {
            indices.push(this.parseExpr());
          } while (this.acceptSymbol(","));
          this.expectSymbol("]", "Expected ']' after indices");
        }
        expr = { tag: "index", array: expr, indices, id: this.newId() };
        continue;
      }
      break;
    }
    return expr;
  }

  private parsePrimary(): Expr {
    const t = this.peek();

    if (t.kind === "int") {
      this.advance();
      const value = parseInt(t.text, 10);
      if (!Number.isSafeInteger(value) || value > INT32_MAX) {
        this.diagnostics.push(error("Integer literal out of 32-bit range", t.start, t.end));
      }
      return { tag: "int_lit", value, id: this.newId() };
    }

    if (t.kind === "float") {
      this.advance();
      const value = parseFloat(t.text);
      if (!Number.isFinite(Math.fround(value))) {
        this.diagnostics.push(error("Float literal out of 32-bit range", t.start, t.end, "FLOAT_RANGE"));
      }
      return { tag: "float_lit", value, id: this.newId() };
    }

    if (this.acceptKeyword("void")) {
      return { tag: "void_lit", id: this.newId() };
    }

    if (this.acceptKeyword("res")) {
      return { tag: "res", id: this.newId() };
    }

    if (this.acceptKeyword("rec")) {
      this.expectSymbol("(", "Expected '(' after rec");
      const args: Expr[] = [];
      if (!this.acceptSymbol(")")) {
        do {
          args.push(this.parseExpr());
        } while (this.acceptSymbol(","));
        this.expectSymbol(")", "Expected ')' after rec arguments");
      }
      return { tag: "rec", args, id: this.newId() };
    }

    if (this.acceptKeyword("array")) {
      return this.parseComprehension("array_expr");
    }

    if (this.acceptKeyword("sum")) {
      return this.parseComprehension("sum_expr");
    }

    if (this.acceptSymbol("[")) {
      return this.parseArrayLiteral();
    }

    if (this.acceptSymbol("(")) {
      const expr = this.parseExpr();
      this.expectSymbol(")", "Expected ')' to close expression");
      return expr;
    }

    if (t.kind === "ident" && REMOVED_KEYWORDS.has(t.text)) {
      this.diagnostics.push(error(`'${t.text}' is not a keyword in JPL--`, t.start, t.end));
      this.advance();
      return { tag: "void_lit", id: this.newId() };
    }

    if (t.kind === "ident") {
      this.advance();
      if (this.acceptSymbol("(")) {
        const args: Expr[] = [];
        if (!this.acceptSymbol(")")) {
          do {
            args.push(this.parseExpr());
          } while (this.acceptSymbol(","));
          this.expectSymbol(")", "Expected ')' after call arguments");
        }
        return { tag: "call", name: t.text, args, id: this.newId() };
      }
      if (this.acceptSymbol("{")) {
        const fields: Expr[] = [];
        if (!this.acceptSymbol("}")) {
          do {
            fields.push(this.parseExpr());
          } while (this.acceptSymbol(","));
          this.expectSymbol("}", "Expected '}' after struct constructor fields");
        }
        return { tag: "struct_cons", name: t.text, fields, id: this.newId() };
      }
      return { tag: "var", name: t.text, id: this.newId() };
    }

    this.diagnostics.push(error(`Unexpected token '${t.text}' in expression`, t.start, t.end));
    this.advance();
    return { tag: "void_lit", id: this.newId() };
  }

  private parseArrayLiteral(): Expr {
    const elements: Expr[] = [];
    if (!this.acceptSymbol("]")) {
      do {
        elements.push(this.parseExpr());
      } while (this.acceptSymbol(","));
      this.expectSymbol("]", "Expected ']' after array literal elements");
    }
    return { tag: "array_cons", elements, id: this.newId() };
  }

  private parseComprehension(tag: "array_expr" | "sum_expr"): Expr {
    this.expectSymbol("[", `Expected '[' after ${tag === "array_expr" ? "array" : "sum"}`);
    const bindings = this.parseBindings();
    this.expectSymbol("]", "Expected ']' after comprehension bindings");
    const body = this.parseExpr();
    if (body.tag === tag) {
      return {
        tag,
        bindings: [...bindings, ...body.bindings],
        body: body.body,
        id: this.newId(),
      };
    }
    return { tag, bindings, body, id: this.newId() };
  }

  private parseBindings(): Binding[] {
    const bindings: Binding[] = [];
    do {
      const name = this.expectIdent("Expected binder name in comprehension");
      this.expectSymbol(":", "Expected ':' after comprehension binder");
      bindings.push({ name, expr: this.parseExpr() });
    } while (this.acceptSymbol(","));
    return bindings;
  }

  private newId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  private isEof(): boolean {
    return this.peek().kind === "eof";
  }

  private peek(): Token {
    return this.tokens[this.idx] ?? this.tokens[this.tokens.length - 1]!;
  }

  private advance(): Token {
    const t = this.peek();
    this.idx += 1;
    return t;
  }

  private acceptKeyword(text: string): boolean {
    const t = this.peek();
    if (t.kind === "keyword" && t.text === text) {
      this.advance();
      return true;
    }
    return false;
  }

  private acceptSymbol(text: string): boolean {
    const t = this.peek();
    if (t.kind === "symbol" && t.text === text) {
      this.advance();
      return true;
    }
    return false;
  }

  private expectSymbol(text: string, message: string): void {
    const t = this.peek();
    if (this.acceptSymbol(text)) {
      return;
    }
    this.diagnostics.push(error(message, t.start, t.end));
  }

  private expectKeyword(text: string, message: string): void {
    const t = this.peek();
    if (this.acceptKeyword(text)) {
      return;
    }
    this.diagnostics.push(error(message, t.start, t.end));
  }

  private expectIdent(message: string): string {
    const t = this.peek();
    if (t.kind === "ident") {
      if (REMOVED_KEYWORDS.has(t.text)) {
        this.diagnostics.push(error(`'${t.text}' is not a valid identifier in JPL--`, t.start, t.end));
        this.advance();
        return "_error";
      }
      this.advance();
      return t.text;
    }
    this.diagnostics.push(error(message, t.start, t.end));
    this.advance();
    return "_error";
  }

  private expectString(message: string): string {
    const t = this.peek();
    if (t.kind === "string") {
      this.advance();
      return t.text;
    }
    this.diagnostics.push(error(message, t.start, t.end));
    if (!this.isEof()) {
      this.advance();
    }
    return "";
  }
}

export function parseSource(source: string): ParseResult {
  try {
    const parser = new Parser(tokenize(source));
    return parser.parseProgram();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unexpected parse failure";
    return {
      program: { commands: [] },
      diagnostics: [error(msg, 0, 0, "PARSE_CRASH")],
    };
  }
}
