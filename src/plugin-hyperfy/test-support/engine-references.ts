/**
 * Finds, in engine and agent sources, every member that turns a value a script passes into a node
 * or geometry, and every node property a constructor fills from its data (lib/script-api.test.ts
 * checks each is guarded). Parsed with the TypeScript compiler.
 *
 * Found:
 * - getRef( under any name it is imported or assigned as, as N.getRef( of a namespace import, and
 *   through .call/.apply;
 * - `_ref` read as a property or a destructured name, and every constant string equal to "_ref"
 *   wherever it is used (`value['_ref']`, `Reflect.get(value, '_ref')`, a key built from literals
 *   with + or a template, a const bound to one);
 * - inside getProxy(): a member that hands a value derived from its arguments (a parameter, a rest
 *   parameter's element, `arguments`, a local alias, destructuring or a property of one) to
 *   add/insert/remove/attach, to `.children.push/unshift/splice` or an element of `.children`, to
 *   `.activate()` called on it, or to a function or method of this file that does one of these
 *   (followed to any depth); a spread or Object.assign() of another object (it reads the getters
 *   once, `_ref` included);
 * - in a constructor: a property of `this` (or of an alias of `this`) set from the data parameter,
 *   whatever it is called, as `data.x`, `data?.x`, `data['x']`, `data.x ?? d` (also || && ?:),
 *   through an alias or a destructuring of the data, and Object.assign(this, data) (reported with
 *   the property "*").
 *
 * Not found, because a syntactic scan cannot see it: a key computed at run time (`value[name]`
 * where name is not a constant string); a value that reaches those calls through a function of
 * another file, a call's result, a closure variable assigned elsewhere, a callback or an event; a
 * proxy member added outside getProxy(); a constructor that hands its data to a function of its
 * own (other than to a setter by assignment); and code run through eval or new Function.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export type Reading = 'getRef' | '_ref' | 'adopts its argument' | 'spreads a proxy';

export interface Finding {
  file: string;
  member: string;
  how: Reading;
}

export interface ConstructionProperty {
  /** The class whose constructor sets it */
  className: string;
  /** The property of `this` that is set ("*" for Object.assign(this, data)) */
  property: string;
  /** The key of the data it is set from ("*" for Object.assign(this, data)) */
  dataKey: string;
}

const ADOPTING_CALLS = new Set(['add', 'insert', 'remove', 'attach']);
const CHILD_LIST_CALLS = new Set(['push', 'unshift', 'splice']);
const MAX_DEPTH = 12;

function propertyName(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** Every identifier a binding name binds, with the property it takes from the bound value ('' when not an object property) */
function bindings(name: ts.BindingName, key = ''): [string, string][] {
  if (ts.isIdentifier(name)) return [[name.text, key]];
  return name.elements.flatMap((element): [string, string][] => {
    if (ts.isOmittedExpression(element)) return [];
    const elementKey = ts.isObjectBindingPattern(name) ? (propertyName(element.propertyName) ?? propertyName(element.name) ?? '') : '';
    return bindings(element.name, elementKey);
  });
}

/** const declarations with a single name, by name: what constant strings resolve through */
function constants(source: ts.SourceFile): Map<string, ts.Expression[]> {
  const found = new Map<string, ts.Expression[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isVariableDeclarationList(node.parent) && node.parent.flags & ts.NodeFlags.Const) {
      found.set(node.name.text, [...(found.get(node.name.text) ?? []), node.initializer]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The strings an expression can be when it is built from literals only (empty when it is not) */
function stringsOf(expr: ts.Expression, consts: Map<string, ts.Expression[]>, depth = 0): string[] {
  if (depth > MAX_DEPTH) return [];
  const inner = unwrap(expr);
  if (ts.isStringLiteralLike(inner)) return [inner.text];
  if (ts.isIdentifier(inner)) return (consts.get(inner.text) ?? []).flatMap((init) => stringsOf(init, consts, depth + 1));
  const combine = (parts: string[][]): string[] =>
    parts.reduce<string[]>((all, options) => all.flatMap((prefix) => options.map((option) => prefix + option)).slice(0, 64), ['']);
  if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = stringsOf(inner.left, consts, depth + 1);
    const right = stringsOf(inner.right, consts, depth + 1);
    return left.length && right.length ? combine([left, right]) : [];
  }
  if (ts.isTemplateExpression(inner)) {
    const parts: string[][] = [[inner.head.text]];
    for (const span of inner.templateSpans) {
      const values = stringsOf(span.expression, consts, depth + 1);
      if (!values.length) return [];
      parts.push(values, [span.literal.text]);
    }
    return combine(parts);
  }
  return [];
}

/** The member a node belongs to: the innermost named method, accessor, function or function-valued property */
function memberOf(node: ts.Node): string {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isGetAccessorDeclaration(current)) return `get ${propertyName(current.name) ?? '?'}`;
    if (ts.isSetAccessorDeclaration(current)) return `set ${propertyName(current.name) ?? '?'}`;
    if (ts.isMethodDeclaration(current)) return propertyName(current.name) ?? '?';
    if (ts.isFunctionDeclaration(current)) return `function ${current.name?.text ?? '?'}`;
    if (ts.isConstructorDeclaration(current)) return 'constructor';
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && current.parent) {
      const parent = current.parent;
      if (ts.isPropertyAssignment(parent) || ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) {
        const name = propertyName(parent.name);
        if (name) return name;
      }
    }
  }
  return '<top level>';
}

/** Whether `node` is inside the body of a method or function named getProxy */
function inGetProxy(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if ((ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) && propertyName(current.name) === 'getProxy') return true;
  }
  return false;
}

function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return current;
  }
  return undefined;
}

/**
 * The local names of one function (not of functions inside it) and what each is bound from:
 * a variable's initializer, or the collection a for-of/for-in loop variable takes its values from.
 */
function localsOf(fn: ts.SignatureDeclaration): Map<string, ts.Expression[]> {
  const locals = new Map<string, ts.Expression[]>();
  const bind = (name: ts.BindingName, from: ts.Expression) => {
    for (const [local] of bindings(name)) locals.set(local, [...(locals.get(local) ?? []), from]);
  };
  const visit = (node: ts.Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && node.initializer) bind(node.name, node.initializer);
    if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && ts.isVariableDeclarationList(node.initializer)) {
      for (const declaration of node.initializer.declarations) bind(declaration.name, node.expression);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      locals.set(node.left.text, [...(locals.get(node.left.text) ?? []), node.right]);
    }
    ts.forEachChild(node, visit);
  };
  if ('body' in fn && fn.body) visit(fn.body);
  return locals;
}

const parameterNames = (fn: ts.SignatureDeclaration): string[][] => fn.parameters.map((parameter) => bindings(parameter.name).map(([name]) => name));

/** Whether `expr` is derived from one of the `sources` names of the function (see the header) */
function derivedFrom(expr: ts.Expression, sources: Set<string>, locals: Map<string, ts.Expression[]>, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  const inner = unwrap(expr);
  const again = (next: ts.Expression) => derivedFrom(next, sources, locals, depth + 1);
  if (ts.isIdentifier(inner)) return sources.has(inner.text) || (locals.get(inner.text) ?? []).some(again);
  if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) return again(inner.expression);
  if (ts.isSpreadElement(inner)) return again(inner.expression);
  if (ts.isConditionalExpression(inner)) return again(inner.whenTrue) || again(inner.whenFalse);
  if (ts.isBinaryExpression(inner)) {
    const kind = inner.operatorToken.kind;
    if (kind === ts.SyntaxKind.QuestionQuestionToken || kind === ts.SyntaxKind.BarBarToken || kind === ts.SyntaxKind.AmpersandAmpersandToken || kind === ts.SyntaxKind.CommaToken) {
      return again(inner.left) || again(inner.right);
    }
  }
  return false;
}

interface Adoption {
  /** Functions and methods of the file, by name: the indexes of the parameters they adopt */
  helpers: Map<string, Set<number>>;
}

/** Whether a call adopts a derived value: see the header */
function callAdopts(call: ts.CallExpression, derived: (expr: ts.Expression) => boolean, { helpers }: Adoption): boolean {
  const callee = unwrap(call.expression);
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : undefined;
  if (name === undefined) return false;
  const argumentAt = (index: number): boolean => {
    // A spread argument may put a derived value at any position
    const spread = call.arguments.slice(0, index + 1).some((arg) => ts.isSpreadElement(arg) && derived(arg));
    return spread || (call.arguments[index] !== undefined && derived(call.arguments[index]));
  };
  if (ts.isPropertyAccessExpression(callee)) {
    if (ADOPTING_CALLS.has(name) && argumentAt(0)) return true;
    if (name === 'activate' && derived(callee.expression)) return true;
    const list = unwrap(callee.expression);
    if (CHILD_LIST_CALLS.has(name) && ts.isPropertyAccessExpression(list) && list.name.text === 'children' && call.arguments.some((arg) => derived(arg))) return true;
  }
  const adopted = helpers.get(name);
  return !!adopted && [...adopted].some(argumentAt);
}

/** An assignment of a derived value to an element of `.children` */
function assignsChild(node: ts.BinaryExpression, derived: (expr: ts.Expression) => boolean): boolean {
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  const left = unwrap(node.left);
  if (!ts.isElementAccessExpression(left)) return false;
  const list = unwrap(left.expression);
  return ts.isPropertyAccessExpression(list) && list.name.text === 'children' && derived(node.right);
}

/** Whether, in `fn`, a value derived from `sources` is adopted */
function adoptsWithin(fn: ts.SignatureDeclaration, sources: Set<string>, adoption: Adoption): boolean {
  const locals = localsOf(fn);
  const derived = (expr: ts.Expression) => derivedFrom(expr, sources, locals);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || (node !== fn && ts.isFunctionLike(node))) return;
    if (ts.isCallExpression(node) && callAdopts(node, derived, adoption)) found = true;
    if (ts.isBinaryExpression(node) && assignsChild(node, derived)) found = true;
    ts.forEachChild(node, visit);
  };
  if ('body' in fn && fn.body) visit(fn.body);
  return found;
}

/** The functions and methods of a file that adopt one of their parameters, followed to any depth */
function adoptingHelpers(source: ts.SourceFile): Adoption {
  const functions: [string, ts.SignatureDeclaration][] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.body) {
      const name = propertyName(node.name);
      if (name && name !== 'getProxy') functions.push([name, node]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const adoption: Adoption = { helpers: new Map() };
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, fn] of functions) {
      parameterNames(fn).forEach((names, index) => {
        if (adoption.helpers.get(name)?.has(index)) return;
        if (!adoptsWithin(fn, new Set(names), adoption)) return;
        adoption.helpers.set(name, new Set([...(adoption.helpers.get(name) ?? []), index]));
        changed = true;
      });
    }
  }
  return adoption;
}

/** The names getRef is called by in a file, and whether a call is one */
function getRefCalls(source: ts.SourceFile): (call: ts.CallExpression) => boolean {
  const names = new Set(['getRef']);
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === 'getRef') names.add(node.name.text);
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = unwrap(node.initializer);
      if (ts.isIdentifier(node.name) && ((ts.isIdentifier(init) && names.has(init.text)) || (ts.isPropertyAccessExpression(init) && init.name.text === 'getRef'))) names.add(node.name.text);
      if (ts.isObjectBindingPattern(node.name)) for (const [local, key] of bindings(node.name)) if (key === 'getRef') names.add(local);
    }
    ts.forEachChild(node, visit);
  };
  // Twice: an alias of an alias
  visit(source);
  visit(source);
  const isGetRef = (expr: ts.Expression): boolean => {
    const inner = unwrap(expr);
    return (ts.isIdentifier(inner) && names.has(inner.text)) || (ts.isPropertyAccessExpression(inner) && inner.name.text === 'getRef');
  };
  return (call) => {
    const callee = unwrap(call.expression);
    if (isGetRef(callee)) return call.arguments.length > 0;
    // getRef.call(thisArg, value) / getRef.apply(thisArg, [value])
    return ts.isPropertyAccessExpression(callee) && ['call', 'apply'].includes(callee.name.text) && isGetRef(callee.expression) && call.arguments.length > 1;
  };
}

/** Whether a string-valued expression is a place a constant "_ref" can be used from (not a part of a bigger one) */
function isStringUse(node: ts.Node): node is ts.Expression {
  if (!(ts.isStringLiteralLike(node) || ts.isTemplateExpression(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) || ts.isIdentifier(node))) return false;
  const parent = node.parent;
  if (ts.isIdentifier(node)) {
    // An identifier only where it is used as a value: an element key or a call argument
    return (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) || (ts.isCallExpression(parent) && parent.arguments.includes(node));
  }
  // Property names and import paths are not values
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isImportSpecifier(parent) || ts.isLiteralTypeNode(parent)) return false;
  return true;
}

export function findReferenceReaders(file: string, text: string): Finding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const consts = constants(source);
  const isGetRefCall = getRefCalls(source);
  const adoption = adoptingHelpers(source);
  const found: Finding[] = [];
  const add = (node: ts.Node, how: Reading) => found.push({ file, member: memberOf(node), how });
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isGetRefCall(node)) add(node, 'getRef');
    if (ts.isPropertyAccessExpression(node) && node.name.text === '_ref') add(node, '_ref');
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && (propertyName(node.propertyName) ?? propertyName(node.name)) === '_ref') add(node, '_ref');
    if (isStringUse(node) && stringsOf(node, consts).includes('_ref')) add(node, '_ref');
    if (inGetProxy(node)) {
      if (ts.isSpreadAssignment(node)) add(node, 'spreads a proxy');
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'assign' && ts.isIdentifier(callee.expression) && callee.expression.text === 'Object') add(node, 'spreads a proxy');
      }
      const fn = enclosingFunction(node);
      if (fn && (ts.isCallExpression(node) || ts.isBinaryExpression(node))) {
        const locals = localsOf(fn);
        const sources = new Set([...parameterNames(fn).flat(), 'arguments']);
        const derived = (expr: ts.Expression) => derivedFrom(expr, sources, locals);
        if (ts.isCallExpression(node) ? callAdopts(node, derived, adoption) : assignsChild(node, derived)) add(node, 'adopts its argument');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The data key an expression reads from the constructor's data (see the header), or undefined */
function dataKeyOf(
  expr: ts.Expression,
  data: Set<string>,
  locals: Map<string, ts.Expression[]>,
  destructured: Map<string, string>,
  consts: Map<string, ts.Expression[]>,
  depth = 0
): string | undefined {
  if (depth > MAX_DEPTH) return undefined;
  const inner = unwrap(expr);
  const again = (next: ts.Expression) => dataKeyOf(next, data, locals, destructured, consts, depth + 1);
  const isData = (object: ts.Expression): boolean => {
    const target = unwrap(object);
    return ts.isIdentifier(target) && data.has(target.text);
  };
  if (ts.isPropertyAccessExpression(inner) && isData(inner.expression)) return inner.name.text;
  if (ts.isElementAccessExpression(inner) && isData(inner.expression)) return stringsOf(inner.argumentExpression, consts)[0];
  if (ts.isIdentifier(inner)) {
    if (destructured.has(inner.text)) return destructured.get(inner.text);
    for (const init of locals.get(inner.text) ?? []) {
      const key = again(init);
      if (key !== undefined) return key;
    }
    return undefined;
  }
  if (ts.isConditionalExpression(inner)) return again(inner.whenTrue) ?? again(inner.whenFalse);
  if (ts.isBinaryExpression(inner)) {
    const kind = inner.operatorToken.kind;
    if (kind === ts.SyntaxKind.QuestionQuestionToken || kind === ts.SyntaxKind.BarBarToken || kind === ts.SyntaxKind.AmpersandAmpersandToken) return again(inner.left) ?? again(inner.right);
  }
  return undefined;
}

/**
 * The properties a node class's constructor sets from its data parameter (see the header). The
 * caller decides which matter: a property with a guarded setter, or one the engine reads as a node
 * or geometry.
 */
export function findConstructionProperties(file: string, text: string): ConstructionProperty[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const consts = constants(source);
  const found: ConstructionProperty[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node)) {
      const className = node.name?.text ?? '?';
      const constructor = node.members.find(ts.isConstructorDeclaration);
      const parameter = constructor?.parameters[0];
      if (constructor?.body && parameter) {
        const locals = localsOf(constructor);
        // The data and its aliases; names destructured from it, by the key they take
        const data = new Set<string>();
        const destructured = new Map<string, string>();
        if (ts.isIdentifier(parameter.name)) data.add(parameter.name.text);
        else for (const [local, key] of bindings(parameter.name)) if (key) destructured.set(local, key);
        for (let changed = true; changed; ) {
          changed = false;
          for (const [local, inits] of locals) {
            if (data.has(local)) continue;
            if (inits.some((init) => { const value = unwrap(init); return ts.isIdentifier(value) ? data.has(value.text) : ts.isBinaryExpression(value) && ts.isIdentifier(unwrap(value.left)) && data.has((unwrap(value.left) as ts.Identifier).text); })) {
              data.add(local);
              changed = true;
            }
          }
        }
        const look = (inner: ts.Node): void => {
          if (inner !== constructor && ts.isFunctionLike(inner)) return;
          if (ts.isVariableDeclaration(inner) && ts.isObjectBindingPattern(inner.name) && inner.initializer) {
            const from = unwrap(inner.initializer);
            if (ts.isIdentifier(from) && data.has(from.text)) for (const [local, key] of bindings(inner.name)) if (key) destructured.set(local, key);
          }
          ts.forEachChild(inner, look);
        };
        look(constructor.body);
        const thisAliases = new Set([...locals].filter(([, inits]) => inits.some((init) => unwrap(init).kind === ts.SyntaxKind.ThisKeyword)).map(([name]) => name));
        const isThis = (expr: ts.Expression): boolean => {
          const target = unwrap(expr);
          return target.kind === ts.SyntaxKind.ThisKeyword || (ts.isIdentifier(target) && thisAliases.has(target.text));
        };
        const assignments = (inner: ts.Node): void => {
          if (inner !== constructor && ts.isFunctionLike(inner)) return;
          if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const left = unwrap(inner.left);
            const property = ts.isPropertyAccessExpression(left) && isThis(left.expression)
              ? left.name.text
              : ts.isElementAccessExpression(left) && isThis(left.expression)
                ? stringsOf(left.argumentExpression, consts)[0]
                : undefined;
            const dataKey = property === undefined ? undefined : dataKeyOf(inner.right, data, locals, destructured, consts);
            if (property !== undefined && dataKey !== undefined) found.push({ className, property, dataKey });
          }
          if (ts.isCallExpression(inner)) {
            const callee = unwrap(inner.expression);
            const [target, ...rest] = inner.arguments;
            if (
              ts.isPropertyAccessExpression(callee) && callee.name.text === 'assign' && ts.isIdentifier(callee.expression) && callee.expression.text === 'Object' &&
              target && isThis(target) && rest.some((arg) => { const value = unwrap(arg); return ts.isIdentifier(value) && data.has(value.text); })
            ) {
              found.push({ className, property: '*', dataKey: '*' });
            }
          }
          ts.forEachChild(inner, assignments);
        };
        assignments(constructor.body);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function sourceFiles(dir: string, extension: '.js' | '.ts'): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return sourceFiles(file, extension);
    return name.endsWith(extension) && !name.endsWith('.test.ts') ? [file] : [];
  });
}

export const read = (file: string) => readFileSync(file, 'utf8');
