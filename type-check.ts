import { Stmt, Expr, Type, UniOp, BinOp, Literal, Program, FunDef, VarInit, Class } from "./ast";
import { NUM, BOOL, NONE, CLASS, unhandledTag, unreachable } from "./utils";
import * as BaseException from "./error";

export type GlobalTypeEnv = {
  globals: Map<string, Type>;
  functions: Map<string, [Array<Type>, Type]>;
  classes: Map<string, [Map<string, Type>, Map<string, [Array<Type>, Type]>]>;
};

export type LocalTypeEnv = {
  vars: Map<string, Type>;
  expectedRet: Type;
  topLevel: boolean;
};

const defaultGlobalFunctions = new Map();
defaultGlobalFunctions.set("abs", [[NUM], NUM]);
defaultGlobalFunctions.set("max", [[NUM, NUM], NUM]);
defaultGlobalFunctions.set("min", [[NUM, NUM], NUM]);
defaultGlobalFunctions.set("pow", [[NUM, NUM], NUM]);
defaultGlobalFunctions.set("print", [[CLASS("object")], NUM]);

export const defaultTypeEnv = {
  globals: new Map(),
  functions: defaultGlobalFunctions,
  classes: new Map(),
};

export function emptyGlobalTypeEnv(): GlobalTypeEnv {
  return {
    globals: new Map(),
    functions: new Map(),
    classes: new Map(),
  };
}

export function emptyLocalTypeEnv(): LocalTypeEnv {
  return {
    vars: new Map(),
    expectedRet: NONE,
    topLevel: true,
  };
}

export function equalType(t1: Type, t2: Type) {
  return t1 === t2 || (t1.tag === "class" && t2.tag === "class" && t1.name === t2.name);
}

export function isNoneOrClass(t: Type) {
  return t.tag === "none" || t.tag === "class";
}

export function isSubtype(env: GlobalTypeEnv, t1: Type, t2: Type): boolean {
  return equalType(t1, t2) || (t1.tag === "none" && t2.tag === "class");
}

export function isAssignable(env: GlobalTypeEnv, t1: Type, t2: Type): boolean {
  return isSubtype(env, t1, t2);
}

export function join(env: GlobalTypeEnv, t1: Type, t2: Type): Type {
  return NONE;
}

export function augmentTEnv(env: GlobalTypeEnv, program: Program<null>): GlobalTypeEnv {
  const newGlobs = new Map(env.globals);
  const newFuns = new Map(env.functions);
  const newClasses = new Map(env.classes);
  program.inits.forEach((init) => newGlobs.set(init.name, init.type));
  program.funs.forEach((fun) =>
    newFuns.set(fun.name, [fun.parameters.map((p) => p.type), fun.ret])
  );
  program.classes.forEach((cls) => {
    const fields = new Map();
    const methods = new Map();
    cls.fields.forEach((field) => fields.set(field.name, field.type));
    cls.methods.forEach((method) =>
      methods.set(method.name, [method.parameters.map((p) => p.type), method.ret])
    );
    newClasses.set(cls.name, [fields, methods]);
  });
  return { globals: newGlobs, functions: newFuns, classes: newClasses };
}

export function tc(env: GlobalTypeEnv, program: Program<null>): [Program<Type>, GlobalTypeEnv] {
  const locals = emptyLocalTypeEnv();
  const newEnv = augmentTEnv(env, program);
  const tInits = program.inits.map((init) => tcInit(env, init));
  const tDefs = program.funs.map((fun) => tcDef(newEnv, fun));
  const tClasses = program.classes.map((cls) => tcClass(newEnv, cls));

  // program.inits.forEach(init => env.globals.set(init.name, tcInit(init)));
  // program.funs.forEach(fun => env.functions.set(fun.name, [fun.parameters.map(p => p.type), fun.ret]));
  // program.funs.forEach(fun => tcDef(env, fun));
  // Strategy here is to allow tcBlock to populate the locals, then copy to the
  // global env afterwards (tcBlock changes locals)
  const tBody = tcBlock(newEnv, locals, program.stmts);
  var lastTyp: Type = NONE;
  if (tBody.length) {
    lastTyp = tBody[tBody.length - 1].a;
  }
  // TODO(joe): check for assignment in existing env vs. new declaration
  // and look for assignment consistency
  for (let name of locals.vars.keys()) {
    newEnv.globals.set(name, locals.vars.get(name));
  }
  const aprogram = {
    a: lastTyp,
    inits: tInits,
    funs: tDefs,
    classes: tClasses,
    stmts: tBody,
    loc: program.loc,
  };
  return [aprogram, newEnv];
}

export function tcInit(env: GlobalTypeEnv, init: VarInit<null>): VarInit<Type> {
  const valTyp = tcLiteral(init.value);
  if (isAssignable(env, valTyp, init.type)) {
    return { ...init, a: NONE };
  } else {
    // Some type mismatch is allowed in python, so we use customized TypeMismatchError here, which does not exist in real python.
    throw new BaseException.TypeMismatchError(init.type.tag, valTyp.tag, init.loc);
  }
}

export function tcDef(env: GlobalTypeEnv, fun: FunDef<null>): FunDef<Type> {
  var locals = emptyLocalTypeEnv();
  locals.expectedRet = fun.ret;
  locals.topLevel = false;
  fun.parameters.forEach((p) => locals.vars.set(p.name, p.type));
  fun.inits.forEach((init) => locals.vars.set(init.name, tcInit(env, init).type));

  const tBody = tcBlock(env, locals, fun.body);
  return { ...fun, a: NONE, body: tBody };
}

export function tcClass(env: GlobalTypeEnv, cls: Class<null>): Class<Type> {
  const tFields = cls.fields.map((field) => tcInit(env, field));
  const tMethods = cls.methods.map((method) => tcDef(env, method));
  return { a: NONE, name: cls.name, fields: tFields, methods: tMethods, loc: cls.loc };
}

export function tcBlock(
  env: GlobalTypeEnv,
  locals: LocalTypeEnv,
  stmts: Array<Stmt<null>>
): Array<Stmt<Type>> {
  return stmts.map((stmt) => tcStmt(env, locals, stmt));
}

export function tcStmt(env: GlobalTypeEnv, locals: LocalTypeEnv, stmt: Stmt<null>): Stmt<Type> {
  switch (stmt.tag) {
    case "assignment":
      throw new BaseException.Exception(
        "Destructured assignment not implemented",
        undefined,
        stmt.loc
      );
    case "assign":
      const tValExpr = tcExpr(env, locals, stmt.value);
      var nameTyp;
      if (locals.vars.has(stmt.name)) {
        nameTyp = locals.vars.get(stmt.name);
      } else if (env.globals.has(stmt.name)) {
        nameTyp = env.globals.get(stmt.name);
      } else {
        throw new BaseException.NameError(stmt.name, stmt.loc);
      }
      if (!isAssignable(env, tValExpr.a, nameTyp)) {
        //throw new BaseException.Exception("Non-assignable types");
        throw new BaseException.TypeMismatchError(nameTyp.tag, tValExpr.a.tag, stmt.loc);
      }
      return { a: NONE, tag: stmt.tag, name: stmt.name, value: tValExpr, loc: stmt.loc };
    case "expr":
      const tExpr = tcExpr(env, locals, stmt.expr);
      return { a: tExpr.a, tag: stmt.tag, expr: tExpr, loc: stmt.loc };
    case "if":
      var tCond = tcExpr(env, locals, stmt.cond);
      const tThn = tcBlock(env, locals, stmt.thn);
      const thnTyp = tThn[tThn.length - 1].a;
      const tEls = tcBlock(env, locals, stmt.els);
      const elsTyp = tEls[tEls.length - 1].a;
      if (tCond.a !== BOOL) {
        // Python allows condition to be not bool. So we create this ConditionTypeError here, which does not exist in real python.
        throw new BaseException.ConditionTypeError(tCond.a.tag, tCond.loc);
      } else if (thnTyp !== elsTyp)
        throw new BaseException.SyntaxError("Types of then and else branches must match", stmt.loc);
      return { a: thnTyp, tag: stmt.tag, cond: tCond, thn: tThn, els: tEls, loc: stmt.loc };
    case "return":
      if (locals.topLevel)
        throw new BaseException.SyntaxError("‘return’ outside of functions", stmt.loc);
      const tRet = tcExpr(env, locals, stmt.value);
      if (!isAssignable(env, tRet.a, locals.expectedRet))
        throw new BaseException.TypeMismatchError(
          locals.expectedRet.tag === "class"
            ? (locals.expectedRet as any).name
            : locals.expectedRet.tag,
          tRet.a.tag === "class" ? (tRet.a as any).name : tRet.a.tag,
          stmt.loc
        );
      return { a: tRet.a, tag: stmt.tag, value: tRet, loc: stmt.loc };
    case "while":
      var tCond = tcExpr(env, locals, stmt.cond);
      const tBody = tcBlock(env, locals, stmt.body);
      if (!equalType(tCond.a, BOOL))
        throw new BaseException.ConditionTypeError(tCond.a.tag, tCond.loc);
      return { a: NONE, tag: stmt.tag, cond: tCond, body: tBody, loc: stmt.loc };
    case "pass":
      return { a: NONE, tag: stmt.tag, loc: stmt.loc };
    case "field-assign":
      var tObj = tcExpr(env, locals, stmt.obj);
      const tVal = tcExpr(env, locals, stmt.value);
      if (tObj.a.tag !== "class") {
        throw new BaseException.AttributeError(tObj.a.tag, stmt.field, stmt.loc);
      }
      if (!env.classes.has(tObj.a.name)) {
        throw new BaseException.NameError(tObj.a.name, stmt.loc);
      }
      const [fields, _] = env.classes.get(tObj.a.name);
      if (!fields.has(stmt.field)) {
        throw new BaseException.AttributeError(tObj.a.name, stmt.field, stmt.loc);
      }
      if (!isAssignable(env, tVal.a, fields.get(stmt.field))) {
        throw new BaseException.TypeMismatchError(fields.get(stmt.field).tag, tVal.a.tag, stmt.loc);
      }
      return { ...stmt, a: NONE, obj: tObj, value: tVal };
  }
}

export function tcExpr(env: GlobalTypeEnv, locals: LocalTypeEnv, expr: Expr<null>): Expr<Type> {
  switch (expr.tag) {
    case "literal":
      return { ...expr, a: tcLiteral(expr.value) };
    case "binop":
      const tLeft = tcExpr(env, locals, expr.left);
      const tRight = tcExpr(env, locals, expr.right);
      const tBin = { ...expr, left: tLeft, right: tRight };
      switch (expr.op) {
        case BinOp.Plus:
        case BinOp.Minus:
        case BinOp.Mul:
        case BinOp.IDiv:
        case BinOp.Mod:
          if (equalType(tLeft.a, NUM) && equalType(tRight.a, NUM)) {
            return { a: NUM, ...tBin };
          } else {
            throw new BaseException.UnsupportedOprandTypeError(
              BinOp[expr.op],
              [tLeft.a.tag, tRight.a.tag],
              expr.loc
            );
          }
        case BinOp.Eq:
        case BinOp.Neq:
          if (equalType(tLeft.a, tRight.a)) {
            return { a: BOOL, ...tBin };
          } else {
            throw new BaseException.UnsupportedOprandTypeError(
              BinOp[expr.op],
              [tLeft.a.tag, tRight.a.tag],
              expr.loc
            );
          }
        case BinOp.Lte:
        case BinOp.Gte:
        case BinOp.Lt:
        case BinOp.Gt:
          if (equalType(tLeft.a, NUM) && equalType(tRight.a, NUM)) {
            return { a: BOOL, ...tBin };
          } else {
            throw new BaseException.UnsupportedOprandTypeError(
              BinOp[expr.op],
              [tLeft.a.tag, tRight.a.tag],
              expr.loc
            );
          }
        case BinOp.And:
        case BinOp.Or:
          if (equalType(tLeft.a, BOOL) && equalType(tRight.a, BOOL)) {
            return { a: BOOL, ...tBin };
          } else {
            throw new BaseException.UnsupportedOprandTypeError(
              BinOp[expr.op],
              [tLeft.a.tag, tRight.a.tag],
              expr.loc
            );
          }
        case BinOp.Is:
          if (!isNoneOrClass(tLeft.a) || !isNoneOrClass(tRight.a))
            throw new BaseException.UnsupportedOprandTypeError(
              BinOp[expr.op],
              [tLeft.a.tag, tRight.a.tag],
              expr.loc
            );
          return { a: BOOL, ...tBin };
      }
    case "uniop":
      const tExpr = tcExpr(env, locals, expr.expr);
      const tUni = { ...expr, a: tExpr.a, expr: tExpr };
      switch (expr.op) {
        case UniOp.Neg:
          if (equalType(tExpr.a, NUM)) {
            return tUni;
          } else {
            throw new BaseException.UnsupportedOprandTypeError(
              UniOp[expr.op],
              [tExpr.a.tag],
              expr.loc
            );
          }
        case UniOp.Not:
          if (equalType(tExpr.a, BOOL)) {
            return tUni;
          } else {
            throw new BaseException.UnsupportedOprandTypeError(
              UniOp[expr.op],
              [tExpr.a.tag],
              expr.loc
            );
          }
      }
    case "id":
      if (locals.vars.has(expr.name)) {
        return { a: locals.vars.get(expr.name), ...expr };
      } else if (env.globals.has(expr.name)) {
        return { a: env.globals.get(expr.name), ...expr };
      } else {
        throw new BaseException.NameError(expr.name, expr.loc);
      }
    case "builtin1":
      if (expr.name === "print") {
        const tArg = tcExpr(env, locals, expr.arg);
        return { ...expr, a: tArg.a, arg: tArg };
      } else if (env.functions.has(expr.name)) {
        const [[expectedArgTyp], retTyp] = env.functions.get(expr.name);
        const tArg = tcExpr(env, locals, expr.arg);

        if (isAssignable(env, tArg.a, expectedArgTyp)) {
          return { ...expr, a: retTyp, arg: tArg };
        } else {
          throw new BaseException.TypeMismatchError(
            expectedArgTyp.tag === "class" ? expectedArgTyp.name : expectedArgTyp.tag,
            tArg.a.tag === "class" ? tArg.a.name : tArg.tag,
            expr.loc
          );
        }
      } else {
        throw new BaseException.NameError(expr.name, expr.loc);
      }
    case "builtin2":
      if (env.functions.has(expr.name)) {
        const [[leftTyp, rightTyp], retTyp] = env.functions.get(expr.name);
        const tLeftArg = tcExpr(env, locals, expr.left);
        const tRightArg = tcExpr(env, locals, expr.right);
        if (isAssignable(env, leftTyp, tLeftArg.a) && isAssignable(env, rightTyp, tRightArg.a)) {
          return { ...expr, a: retTyp, left: tLeftArg, right: tRightArg };
        } else {
          throw new BaseException.TypeMismatchError(
            toObject([leftTyp, rightTyp]),
            toObject([tLeftArg.a, tRightArg.a]),
            expr.loc
          );
        }
      } else {
        throw new BaseException.NameError(expr.name, expr.loc);
      }
    case "call":
      if (env.classes.has(expr.name)) {
        // surprise surprise this is actually a constructor
        const tConstruct: Expr<Type> = {
          a: CLASS(expr.name),
          tag: "construct",
          name: expr.name,
          loc: expr.loc,
        };
        const [_, methods] = env.classes.get(expr.name);
        if (methods.has("__init__")) {
          const [initArgs, initRet] = methods.get("__init__");
          if (expr.arguments.length !== initArgs.length - 1) {
            throw new BaseException.TypeError(
              `__init__() takes ${initArgs.length} positional arguments but ${
                expr.arguments.length + 1
              } were given`,
              expr.loc
            );
          }
          if (initRet !== NONE) {
            throw new BaseException.TypeError(
              `__init__() should return None, not '${
                initRet.tag == "class" ? initRet.name : initRet.tag
              }'`,
              expr.loc
            );
          }
          return tConstruct;
        } else {
          return tConstruct;
        }
      } else if (env.functions.has(expr.name)) {
        const [argTypes, retType] = env.functions.get(expr.name);
        const tArgs = expr.arguments.map((arg) => tcExpr(env, locals, arg));

        if (
          argTypes.length === expr.arguments.length &&
          tArgs.every((tArg, i) => tArg.a === argTypes[i])
        ) {
          return { ...expr, a: retType, arguments: expr.arguments };
        } else if (argTypes.length != expr.arguments.length) {
          throw new BaseException.TypeError(
            `${expr.name} takes ${argTypes.length} positional arguments but ${expr.arguments.length} were given`,
            expr.loc
          );
        } else {
          throw new BaseException.TypeMismatchError(
            toObject(argTypes),
            toObject(
              tArgs.map((s) => {
                return s.a;
              })
            ),
            expr.loc
          );
        }
      } else {
        throw new BaseException.NameError(expr.name, expr.loc);
      }
    case "lookup":
      var tObj = tcExpr(env, locals, expr.obj);
      if (tObj.a.tag === "class") {
        if (env.classes.has(tObj.a.name)) {
          const [fields, _] = env.classes.get(tObj.a.name);
          if (fields.has(expr.field)) {
            return { ...expr, a: fields.get(expr.field), obj: tObj };
          } else {
            throw new BaseException.AttributeError(tObj.a.name, expr.field, expr.loc);
          }
        } else {
          throw new BaseException.NameError(tObj.a.name, expr.loc);
        }
      } else {
        throw new BaseException.AttributeError(tObj.a.tag, expr.field, expr.loc);
      }
    case "method-call":
      var tObj = tcExpr(env, locals, expr.obj);
      var tArgs = expr.arguments.map((arg) => tcExpr(env, locals, arg));
      if (tObj.a.tag === "class") {
        if (env.classes.has(tObj.a.name)) {
          const [_, methods] = env.classes.get(tObj.a.name);
          if (methods.has(expr.method)) {
            const [methodArgs, methodRet] = methods.get(expr.method);
            const realArgs = [tObj].concat(tArgs);
            if (
              methodArgs.length === realArgs.length &&
              methodArgs.every((argTyp, i) => isAssignable(env, realArgs[i].a, argTyp))
            ) {
              return { ...expr, a: methodRet, obj: tObj, arguments: tArgs };
            } else if (methodArgs.length != realArgs.length) {
              throw new BaseException.TypeError(
                `${expr.method} takes ${methodArgs.length} positional arguments but ${realArgs.length} were given`,
                expr.loc
              );
            } else {
              throw new BaseException.TypeMismatchError(
                toObject(methodArgs),
                toObject(
                  realArgs.map((s) => {
                    return s.a;
                  })
                ),
                expr.loc
              );
            }
          } else {
            throw new BaseException.AttributeError(tObj.a.name, expr.method, expr.loc);
          }
        } else {
          throw new BaseException.NameError(tObj.a.name, expr.loc);
        }
      } else {
        throw new BaseException.AttributeError(tObj.a.tag, expr.method, expr.loc);
      }
    default:
      throw new BaseException.Exception(
        `unimplemented type checking for expr: ${expr}`,
        undefined,
        expr.loc
      );
  }
}

export function tcLiteral(literal: Literal) {
  switch (literal.tag) {
    case "bool":
      return BOOL;
    case "num":
      return NUM;
    case "none":
      return NONE;
    default:
      unhandledTag(literal);
  }
}

export function toObject(types: Type[]): string {
  return `[${types
    .map((s) => {
      return s.tag === "class" ? s.name : s.tag;
    })
    .join(",")}]`;
}
