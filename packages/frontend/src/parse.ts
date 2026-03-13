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
    const throwsErrorToken = this.acceptKeywordToken("throwserror");
    if (throwsErrorToken) {
      return this.parseThrowsErrorCmd(throwsErrorToken);
    }
    const funToken =
      this.acceptKeywordToken("fun")
      ?? this.acceptKeywordToken("def")
      ?? this.acceptKeywordToken("ref")
      ?? this.acceptKeywordToken("fn");
    if (funToken) {
      return this.parseFnDef(funToken);
    }
    const letToken = this.acceptKeywordToken("let");
    if (letToken) {
      return this.parseLetCmd(letToken);
    }
    const structToken = this.acceptKeywordToken("struct");
    if (structToken) {
      return this.parseStructDef(structToken);
    }
    const readToken = this.acceptKeywordToken("read");
    if (readToken) {
      return this.parseReadImageCmd(readToken);
    }
    const writeToken = this.acceptKeywordToken("write");
    if (writeToken) {
      return this.parseWriteImageCmd(writeToken);
    }
    const printToken = this.acceptKeywordToken("print");
    if (printToken) {
      return this.parsePrintCmd(printToken);
    }
    const showToken = this.acceptWordToken("out") ?? this.acceptKeywordToken("show");
    if (showToken) {
      return this.parseShowCmd(showToken);
    }
    const timeToken = this.acceptKeywordToken("time");
    if (timeToken) {
      return this.parseTimeCmd(timeToken);
    }
    return null;
  }

  private parseFnDef(startToken: Token): Cmd {
    const nameToken = this.expectIdentToken("Expected function name after 'fun'");
    this.expectSymbol("(", "Expected '(' after function name");
    const params: Param[] = [];
    if (!this.acceptSymbol(")")) {
      do {
        const paramName = this.expectIdentToken("Expected parameter name");
        this.expectSymbol(":", "Expected ':' after parameter name");
        const paramType = this.parseType();
        params.push(this.withSpan({ name: paramName.text, type: paramType }, paramName.start, this.nodeEnd(paramType)));
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

    return this.withSpan({
      tag: "fn_def",
      keyword: startToken.text as import("@jplmm/ast").FunctionKeyword,
      name: nameToken.text,
      params,
      retType,
      body,
      id: this.newId(),
    }, startToken.start, this.lastEnd());
  }

  private parseStructDef(startToken: Token): Cmd {
    const nameToken = this.expectIdentToken("Expected struct name after 'struct'");
    this.expectSymbol("{", "Expected '{' after struct name");
    const fields: StructField[] = [];
    while (!this.acceptSymbol("}") && !this.isEof()) {
      const fieldName = this.expectIdentToken("Expected struct field name");
      this.expectSymbol(":", "Expected ':' after struct field name");
      const fieldType = this.parseType();
      fields.push(this.withSpan({ name: fieldName.text, type: fieldType }, fieldName.start, this.nodeEnd(fieldType)));
      if (!this.acceptSymbol(",")) {
        this.acceptSymbol(";");
      }
    }
    return this.withSpan({ tag: "struct_def", name: nameToken.text, fields, id: this.newId() }, startToken.start, this.lastEnd());
  }

  private parseLetCmd(startToken: Token): Cmd {
    const lvalue = this.parseLValue();
    this.expectSymbol("=", "Expected '=' in top-level let command");
    const expr = this.parseExpr();
    return this.withSpan({ tag: "let_cmd", lvalue, expr, id: this.newId() }, startToken.start, this.nodeEnd(expr));
  }

  private parseReadImageCmd(startToken: Token): Cmd {
    this.expectKeyword("image", "Expected 'image' after 'read'");
    const filename = this.expectStringToken("Expected string literal after 'read image'");
    this.expectKeyword("to", "Expected 'to' after image filename");
    const target = this.parseArgument();
    return this.withSpan(
      { tag: "read_image", filename: filename.text, target, id: this.newId() },
      startToken.start,
      this.nodeEnd(target),
    );
  }

  private parseWriteImageCmd(startToken: Token): Cmd {
    this.expectKeyword("image", "Expected 'image' after 'write'");
    const expr = this.parseExpr();
    this.expectKeyword("to", "Expected 'to' after image expression");
    const filename = this.expectStringToken("Expected string literal after 'to'");
    return this.withSpan(
      { tag: "write_image", expr, filename: filename.text, id: this.newId() },
      startToken.start,
      filename.end,
    );
  }

  private parsePrintCmd(startToken: Token): Cmd {
    const message = this.expectStringToken("Expected string literal after 'print'");
    return this.withSpan({ tag: "print", message: message.text, id: this.newId() }, startToken.start, message.end);
  }

  private parseShowCmd(startToken: Token): Cmd {
    const expr = this.parseExpr();
    return this.withSpan({ tag: "show", expr, id: this.newId() }, startToken.start, this.nodeEnd(expr));
  }

  private parseTimeCmd(startToken: Token): Cmd {
    const cmd = this.parseCmd();
    if (!cmd) {
      const t = this.peek();
      this.diagnostics.push(error("Expected a command after 'time'", t.start, t.end));
      return this.withSpan({ tag: "print", message: "", id: this.newId() }, startToken.start, t.end);
    }
    return this.withSpan({ tag: "time", cmd, id: this.newId() }, startToken.start, this.nodeEnd(cmd));
  }

  private parseThrowsErrorCmd(annotation: Token): Cmd {
    this.diagnostics.push(
      error("'throwserror' is unsatisfiable in JPL--: verified functions cannot throw runtime errors", annotation.start, annotation.end, "THROWS_ERROR_IMPOSSIBLE"),
    );

    const cmd = this.parseCmd();
    if (!cmd) {
      const t = this.peek();
      this.diagnostics.push(error("Expected a function definition after 'throwserror'", t.start, t.end, "THROWS_ERROR_TARGET"));
      return this.withSpan({ tag: "print", message: "", id: this.newId() }, annotation.start, t.end);
    }

    if (cmd.tag !== "fn_def" && !(cmd.tag === "time" && cmd.cmd.tag === "fn_def")) {
      this.diagnostics.push(
        error("'throwserror' can only annotate a function definition", annotation.start, annotation.end, "THROWS_ERROR_TARGET"),
      );
    }

    return cmd;
  }

  private parseStmt(): Stmt | null {
    const letToken = this.acceptKeywordToken("let");
    if (letToken) {
      const lvalue = this.parseLValue();
      this.expectSymbol("=", "Expected '=' in let statement");
      const expr = this.parseExpr();
      return this.withSpan({ tag: "let", lvalue, expr, id: this.newId() }, letToken.start, this.nodeEnd(expr));
    }

    const retToken = this.acceptKeywordToken("ret");
    if (retToken) {
      const expr = this.parseExpr();
      return this.withSpan({ tag: "ret", expr, id: this.newId() }, retToken.start, this.nodeEnd(expr));
    }

    const radToken = this.acceptKeywordToken("rad");
    if (radToken) {
      const expr = this.parseExpr();
      return this.withSpan({ tag: "rad", expr, id: this.newId() }, radToken.start, this.nodeEnd(expr));
    }

    const gasToken = this.acceptKeywordToken("gas");
    if (gasToken) {
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
      return this.withSpan({ tag: "gas", limit, id: this.newId() }, gasToken.start, this.lastEnd());
    }

    const t = this.peek();
    this.diagnostics.push(error(`Unexpected token '${t.text}' in function body`, t.start, t.end));
    this.advance();
    return null;
  }

  private parseType(): Type {
    const t = this.peek();
    let base: Type;
    const intToken = this.acceptKeywordToken("int");
    if (intToken) {
      base = this.withSpan({ tag: "int" }, intToken.start, intToken.end);
    } else {
      const floatToken = this.acceptKeywordToken("float");
      if (floatToken) {
        base = this.withSpan({ tag: "float" }, floatToken.start, floatToken.end);
      } else {
        const voidToken = this.acceptKeywordToken("void");
        if (voidToken) {
          base = this.withSpan({ tag: "void" }, voidToken.start, voidToken.end);
        } else if (t.kind === "ident") {
          this.advance();
          base = this.withSpan({ tag: "named", name: t.text }, t.start, t.end);
        } else {
          this.diagnostics.push(error("Expected a type", t.start, t.end));
          this.advance();
          return this.withSpan({ tag: "void" }, t.start, t.end);
        }
      }
    }

    let dims = 0;
    while (this.acceptSymbol("[")) {
      this.expectSymbol("]", "Expected ']' after '[' in array type");
      dims += 1;
    }
    if (dims > 0) {
      return this.withSpan({ tag: "array", element: base, dims }, this.nodeStart(base), this.lastEnd());
    }
    return base;
  }

  private parseLValue(): LValue {
    const openParen = this.acceptSymbolToken("(");
    if (openParen) {
      const items: LValue[] = [];
      if (!this.acceptSymbol(")")) {
        do {
          items.push(this.parseLValue());
        } while (this.acceptSymbol(","));
        this.expectSymbol(")", "Expected ')' after tuple lvalue");
      }
      return this.withSpan({ tag: "tuple", items }, openParen.start, this.lastEnd());
    }

    const name = this.expectIdentToken("Expected variable name");
    if (this.acceptSymbol(".")) {
      const field = this.expectIdentToken("Expected field name after '.'");
      return this.withSpan({ tag: "field", base: name.text, field: field.text }, name.start, field.end);
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
      return this.withSpan({ tag: "var", name: name.text }, name.start, name.end);
    }
    return this.withSpan({ tag: "var", name: name.text }, name.start, name.end);
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
    const openParen = this.acceptSymbolToken("(");
    if (openParen) {
      const items: Argument[] = [];
      if (!this.acceptSymbol(")")) {
        do {
          items.push(this.parseArgument());
        } while (this.acceptSymbol(","));
        this.expectSymbol(")", "Expected ')' after tuple argument");
      }
      return this.withSpan({ tag: "tuple", items }, openParen.start, this.lastEnd());
    }
    const name = this.expectIdentToken("Expected variable name");
    return this.withSpan({ tag: "var", name: name.text }, name.start, name.end);
  }

  private parseExpr(): Expr {
    return this.parseAddSub();
  }

  private parseAddSub(): Expr {
    let expr = this.parseMulDiv();
    while (true) {
      if (this.acceptSymbol("+")) {
        const right = this.parseMulDiv();
        expr = this.withSpan(
          { tag: "binop", op: "+", left: expr, right, id: this.newId() },
          this.nodeStart(expr),
          this.nodeEnd(right),
        );
      } else if (this.acceptSymbol("-")) {
        const right = this.parseMulDiv();
        expr = this.withSpan(
          { tag: "binop", op: "-", left: expr, right, id: this.newId() },
          this.nodeStart(expr),
          this.nodeEnd(right),
        );
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
        const right = this.parseUnary();
        expr = this.withSpan(
          { tag: "binop", op: "*", left: expr, right, id: this.newId() },
          this.nodeStart(expr),
          this.nodeEnd(right),
        );
      } else if (this.acceptSymbol("/")) {
        const right = this.parseUnary();
        expr = this.withSpan(
          { tag: "binop", op: "/", left: expr, right, id: this.newId() },
          this.nodeStart(expr),
          this.nodeEnd(right),
        );
      } else if (this.acceptSymbol("%")) {
        const right = this.parseUnary();
        expr = this.withSpan(
          { tag: "binop", op: "%", left: expr, right, id: this.newId() },
          this.nodeStart(expr),
          this.nodeEnd(right),
        );
      } else {
        break;
      }
    }
    return expr;
  }

  private parseUnary(): Expr {
    const minusToken = this.acceptSymbolToken("-");
    if (minusToken) {
      const next = this.peek();
      if (next.kind === "int") {
        this.advance();
        const value = parseInt(next.text, 10);
        if (!Number.isSafeInteger(value) || value > UINT32_MAX / 2) {
          this.diagnostics.push(error("Integer literal out of 32-bit range", next.start, next.end));
        }
        if (value === UINT32_MAX / 2) {
          return this.withSpan({ tag: "int_lit", value: INT32_MIN, id: this.newId() }, minusToken.start, next.end);
        }
        return this.withSpan({ tag: "int_lit", value: -value, id: this.newId() }, minusToken.start, next.end);
      }
      if (next.kind === "float") {
        this.advance();
        const value = parseFloat(next.text);
        if (!Number.isFinite(Math.fround(-value))) {
          this.diagnostics.push(error("Float literal out of 32-bit range", next.start, next.end, "FLOAT_RANGE"));
        }
        return this.withSpan({ tag: "float_lit", value: -value, id: this.newId() }, minusToken.start, next.end);
      }
      const operand = this.parseUnary();
      return this.withSpan({ tag: "unop", op: "-", operand, id: this.newId() }, minusToken.start, this.nodeEnd(operand));
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    while (true) {
      if (this.acceptSymbol(".")) {
        const field = this.expectIdentToken("Expected field name after '.'");
        expr = this.withSpan(
          { tag: "field", target: expr, field: field.text, id: this.newId() },
          this.nodeStart(expr),
          field.end,
        );
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
        expr = this.withSpan(
          { tag: "index", array: expr, indices, id: this.newId() },
          this.nodeStart(expr),
          this.lastEnd(),
        );
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
      return this.withSpan({ tag: "int_lit", value, id: this.newId() }, t.start, t.end);
    }

    if (t.kind === "float") {
      this.advance();
      const value = parseFloat(t.text);
      if (!Number.isFinite(Math.fround(value))) {
        this.diagnostics.push(error("Float literal out of 32-bit range", t.start, t.end, "FLOAT_RANGE"));
      }
      return this.withSpan({ tag: "float_lit", value, id: this.newId() }, t.start, t.end);
    }

    const voidToken = this.acceptKeywordToken("void");
    if (voidToken) {
      return this.withSpan({ tag: "void_lit", id: this.newId() }, voidToken.start, voidToken.end);
    }

    const resToken = this.acceptKeywordToken("res");
    if (resToken) {
      return this.withSpan({ tag: "res", id: this.newId() }, resToken.start, resToken.end);
    }

    const recToken = this.acceptKeywordToken("rec");
    if (recToken) {
      this.expectSymbol("(", "Expected '(' after rec");
      const args: Expr[] = [];
      if (!this.acceptSymbol(")")) {
        do {
          args.push(this.parseExpr());
        } while (this.acceptSymbol(","));
        this.expectSymbol(")", "Expected ')' after rec arguments");
      }
      return this.withSpan({ tag: "rec", args, id: this.newId() }, recToken.start, this.lastEnd());
    }

    const arrayToken = this.acceptKeywordToken("array");
    if (arrayToken) {
      return this.parseComprehension("array_expr", arrayToken);
    }

    const sumToken = this.acceptKeywordToken("sum");
    if (sumToken) {
      return this.parseComprehension("sum_expr", sumToken);
    }

    const openBracket = this.acceptSymbolToken("[");
    if (openBracket) {
      return this.parseArrayLiteral(openBracket);
    }

    if (this.acceptSymbol("(")) {
      const expr = this.parseExpr();
      this.expectSymbol(")", "Expected ')' to close expression");
      return expr;
    }

    if (t.kind === "ident" && REMOVED_KEYWORDS.has(t.text)) {
      this.diagnostics.push(error(`'${t.text}' is not a keyword in JPL--`, t.start, t.end));
      this.advance();
      return this.withSpan({ tag: "void_lit", id: this.newId() }, t.start, t.end);
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
        return this.withSpan({ tag: "call", name: t.text, args, id: this.newId() }, t.start, this.lastEnd());
      }
      if (this.acceptSymbol("{")) {
        const fields: Expr[] = [];
        if (!this.acceptSymbol("}")) {
          do {
            fields.push(this.parseExpr());
          } while (this.acceptSymbol(","));
          this.expectSymbol("}", "Expected '}' after struct constructor fields");
        }
        return this.withSpan({ tag: "struct_cons", name: t.text, fields, id: this.newId() }, t.start, this.lastEnd());
      }
      return this.withSpan({ tag: "var", name: t.text, id: this.newId() }, t.start, t.end);
    }

    this.diagnostics.push(error(`Unexpected token '${t.text}' in expression`, t.start, t.end));
    this.advance();
    return this.withSpan({ tag: "void_lit", id: this.newId() }, t.start, t.end);
  }

  private parseArrayLiteral(startToken: Token): Expr {
    const elements: Expr[] = [];
    if (!this.acceptSymbol("]")) {
      do {
        elements.push(this.parseExpr());
      } while (this.acceptSymbol(","));
      this.expectSymbol("]", "Expected ']' after array literal elements");
    }
    return this.withSpan({ tag: "array_cons", elements, id: this.newId() }, startToken.start, this.lastEnd());
  }

  private parseComprehension(tag: "array_expr" | "sum_expr", startToken: Token): Expr {
    this.expectSymbol("[", `Expected '[' after ${tag === "array_expr" ? "array" : "sum"}`);
    const bindings = this.parseBindings();
    this.expectSymbol("]", "Expected ']' after comprehension bindings");
    const body = this.parseExpr();
    if (body.tag === tag) {
      return this.withSpan({
        tag,
        bindings: [...bindings, ...body.bindings],
        body: body.body,
        id: this.newId(),
      }, startToken.start, this.nodeEnd(body));
    }
    return this.withSpan({ tag, bindings, body, id: this.newId() }, startToken.start, this.nodeEnd(body));
  }

  private parseBindings(): Binding[] {
    const bindings: Binding[] = [];
    do {
      const name = this.expectIdentToken("Expected binder name in comprehension");
      this.expectSymbol(":", "Expected ':' after comprehension binder");
      const expr = this.parseExpr();
      bindings.push(this.withSpan({ name: name.text, expr }, name.start, this.nodeEnd(expr)));
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

  private previous(): Token {
    return this.tokens[this.idx - 1] ?? this.tokens[0]!;
  }

  private acceptKeyword(text: string): boolean {
    const t = this.peek();
    if (t.kind === "keyword" && t.text === text) {
      this.advance();
      return true;
    }
    return false;
  }

  private acceptWord(text: string): boolean {
    const t = this.peek();
    if ((t.kind === "keyword" || t.kind === "ident") && t.text === text) {
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

  private acceptKeywordToken(text: string): Token | null {
    const t = this.peek();
    if (t.kind === "keyword" && t.text === text) {
      this.advance();
      return t;
    }
    return null;
  }

  private acceptWordToken(text: string): Token | null {
    const t = this.peek();
    if ((t.kind === "keyword" || t.kind === "ident") && t.text === text) {
      this.advance();
      return t;
    }
    return null;
  }

  private acceptSymbolToken(text: string): Token | null {
    const t = this.peek();
    if (t.kind === "symbol" && t.text === text) {
      this.advance();
      return t;
    }
    return null;
  }

  private expectIdentToken(message: string): Token {
    const t = this.peek();
    if (t.kind === "ident") {
      if (REMOVED_KEYWORDS.has(t.text)) {
        this.diagnostics.push(error(`'${t.text}' is not a valid identifier in JPL--`, t.start, t.end));
        this.advance();
        return { ...t, text: "_error" };
      }
      this.advance();
      return t;
    }
    this.diagnostics.push(error(message, t.start, t.end));
    this.advance();
    return { ...t, text: "_error" };
  }

  private expectStringToken(message: string): Token {
    const t = this.peek();
    if (t.kind === "string") {
      this.advance();
      return t;
    }
    this.diagnostics.push(error(message, t.start, t.end));
    if (!this.isEof()) {
      this.advance();
    }
    return { ...t, text: "" };
  }

  private withSpan<const T extends object>(node: T, start: number, end: number): T & { start: number; end: number } {
    return { ...node, start, end };
  }

  private nodeStart(node: { start?: number }): number {
    return node.start ?? this.peek().start;
  }

  private nodeEnd(node: { end?: number }): number {
    return node.end ?? this.lastEnd();
  }

  private lastEnd(): number {
    return this.previous().end;
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
