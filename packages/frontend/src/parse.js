import { REMOVED_KEYWORDS, tokenize } from "@jplmm/grammar";
import { error } from "./errors";
const INT32_MAX = 2147483647;
class Parser {
    tokens;
    idx = 0;
    nextId = 1;
    diagnostics = [];
    constructor(tokens) {
        this.tokens = tokens;
    }
    parseProgram() {
        const commands = [];
        while (!this.isEof()) {
            if (this.acceptKeyword("fn")) {
                commands.push(this.parseFnDef());
            }
            else if (this.acceptKeyword("let")) {
                commands.push(this.parseLetCmd());
            }
            else {
                const t = this.peek();
                this.diagnostics.push(error(`Unexpected token '${t.text}' at top-level`, t.start, t.end));
                this.advance();
            }
            this.acceptSymbol(";");
        }
        return { program: { commands }, diagnostics: this.diagnostics };
    }
    parseFnDef() {
        const name = this.expectIdent("Expected function name after 'fn'");
        this.expectSymbol("(", "Expected '(' after function name");
        const params = [];
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
        const body = [];
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
    parseLetCmd() {
        const lvalue = this.parseLValue();
        this.expectSymbol("=", "Expected '=' in top-level let command");
        const expr = this.parseExpr();
        return { tag: "let_cmd", lvalue, expr, id: this.newId() };
    }
    parseStmt() {
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
            let limit;
            if (this.acceptKeyword("inf")) {
                limit = "inf";
            }
            else if (t.kind === "int") {
                this.advance();
                limit = parseInt(t.text, 10);
            }
            else {
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
    parseType() {
        const t = this.peek();
        let base;
        if (this.acceptKeyword("int")) {
            base = { tag: "int" };
        }
        else if (this.acceptKeyword("float")) {
            base = { tag: "float" };
        }
        else if (this.acceptKeyword("void")) {
            base = { tag: "void" };
        }
        else if (t.kind === "ident") {
            this.advance();
            base = { tag: "named", name: t.text };
        }
        else {
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
    parseLValue() {
        const name = this.expectIdent("Expected variable name");
        return { tag: "var", name };
    }
    parseExpr() {
        return this.parseAddSub();
    }
    parseAddSub() {
        let expr = this.parseMulDiv();
        while (true) {
            if (this.acceptSymbol("+")) {
                expr = { tag: "binop", op: "+", left: expr, right: this.parseMulDiv(), id: this.newId() };
            }
            else if (this.acceptSymbol("-")) {
                expr = { tag: "binop", op: "-", left: expr, right: this.parseMulDiv(), id: this.newId() };
            }
            else {
                break;
            }
        }
        return expr;
    }
    parseMulDiv() {
        let expr = this.parseUnary();
        while (true) {
            if (this.acceptSymbol("*")) {
                expr = { tag: "binop", op: "*", left: expr, right: this.parseUnary(), id: this.newId() };
            }
            else if (this.acceptSymbol("/")) {
                expr = { tag: "binop", op: "/", left: expr, right: this.parseUnary(), id: this.newId() };
            }
            else if (this.acceptSymbol("%")) {
                expr = { tag: "binop", op: "%", left: expr, right: this.parseUnary(), id: this.newId() };
            }
            else {
                break;
            }
        }
        return expr;
    }
    parseUnary() {
        if (this.acceptSymbol("-")) {
            return { tag: "unop", op: "-", operand: this.parseUnary(), id: this.newId() };
        }
        return this.parsePostfix();
    }
    parsePostfix() {
        let expr = this.parsePrimary();
        while (true) {
            if (this.acceptSymbol(".")) {
                const field = this.expectIdent("Expected field name after '.'");
                expr = { tag: "field", target: expr, field, id: this.newId() };
                continue;
            }
            if (this.acceptSymbol("[")) {
                const indices = [];
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
    parsePrimary() {
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
            return { tag: "float_lit", value: parseFloat(t.text), id: this.newId() };
        }
        if (this.acceptKeyword("void")) {
            return { tag: "void_lit", id: this.newId() };
        }
        if (this.acceptKeyword("res")) {
            return { tag: "res", id: this.newId() };
        }
        if (this.acceptKeyword("rec")) {
            this.expectSymbol("(", "Expected '(' after rec");
            const args = [];
            if (!this.acceptSymbol(")")) {
                do {
                    args.push(this.parseExpr());
                } while (this.acceptSymbol(","));
                this.expectSymbol(")", "Expected ')' after rec arguments");
            }
            return { tag: "rec", args, id: this.newId() };
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
                const args = [];
                if (!this.acceptSymbol(")")) {
                    do {
                        args.push(this.parseExpr());
                    } while (this.acceptSymbol(","));
                    this.expectSymbol(")", "Expected ')' after call arguments");
                }
                return { tag: "call", name: t.text, args, id: this.newId() };
            }
            return { tag: "var", name: t.text, id: this.newId() };
        }
        this.diagnostics.push(error(`Unexpected token '${t.text}' in expression`, t.start, t.end));
        this.advance();
        return { tag: "void_lit", id: this.newId() };
    }
    newId() {
        const id = this.nextId;
        this.nextId += 1;
        return id;
    }
    isEof() {
        return this.peek().kind === "eof";
    }
    peek() {
        return this.tokens[this.idx] ?? this.tokens[this.tokens.length - 1];
    }
    advance() {
        const t = this.peek();
        this.idx += 1;
        return t;
    }
    acceptKeyword(text) {
        const t = this.peek();
        if (t.kind === "keyword" && t.text === text) {
            this.advance();
            return true;
        }
        return false;
    }
    acceptSymbol(text) {
        const t = this.peek();
        if (t.kind === "symbol" && t.text === text) {
            this.advance();
            return true;
        }
        return false;
    }
    expectSymbol(text, message) {
        const t = this.peek();
        if (this.acceptSymbol(text)) {
            return;
        }
        this.diagnostics.push(error(message, t.start, t.end));
    }
    expectIdent(message) {
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
}
export function parseSource(source) {
    try {
        const parser = new Parser(tokenize(source));
        return parser.parseProgram();
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : "Unexpected parse failure";
        return {
            program: { commands: [] },
            diagnostics: [error(msg, 0, 0, "PARSE_CRASH")],
        };
    }
}
//# sourceMappingURL=parse.js.map