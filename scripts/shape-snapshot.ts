/**
 * A snapshot over the shape of everything `unstable_cache` stores.
 *
 * ## The bug this exists to prevent
 *
 * `unstable_cache` keys on its key parts and nothing else — never on the code
 * that produced the value. Adding a field to a cached return type therefore
 * does **not** invalidate the entries already on disk, so the new code reads
 * old objects that are silently missing it.
 *
 * That is not hypothetical. Phase 4 added `variantId` to `SizeAvailability`,
 * every cached product kept its old shape, and add-to-bag quietly believed no
 * size had been chosen because the id it needed was `undefined`. Nothing threw.
 * The build passed. The page looked right. It is the worst bug class in this
 * codebase: silent wrongness with no error anywhere.
 *
 * `SHAPE_VERSION` in `src/lib/queries/cached.ts` fixes it by turning a shape
 * change into a cache miss — but only if somebody remembers to bump it, and
 * "remember to do a thing" is not a mechanism. This is the mechanism.
 *
 * ## How it works
 *
 * Every `cached*` binding in `src/lib/queries/cached.ts` is resolved through
 * the TypeScript checker, its return type is awaited and expanded
 * *structurally* — through every alias, all the way down to primitives — and
 * hashed. Expanding matters: `typeToString` would print `ProductSummary[]` and
 * report no change when a field is added to `ProductSummary`, which is the
 * exact edit that caused the original bug.
 *
 * The hash and the current `SHAPE_VERSION` are recorded in
 * `src/lib/queries/cached.shape.json`. Then:
 *
 *   - shapes unchanged                     -> pass
 *   - shapes changed, SHAPE_VERSION same   -> FAIL. This is the bug.
 *   - shapes changed, SHAPE_VERSION bumped -> FAIL until the snapshot is
 *     re-recorded, so the *next* change is still caught.
 *
 * `npm run shapes` checks. `npm run shapes:write` re-records.
 *
 * Reading a *type* rather than a runtime value is deliberate: the shape that
 * matters is the one the compiler believes in, and it is knowable without a
 * database, a build, or a browser.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import ts from "typescript";

const CACHED_MODULE = "src/lib/queries/cached.ts";
const SNAPSHOT_FILE = "src/lib/queries/cached.shape.json";

/** Deep enough for every real view model here; a guard, not a limit in practice. */
const MAX_DEPTH = 16;

type Snapshot = {
  shapeVersion: string;
  hash: string;
  shapes: Record<string, string>;
};

/* ----------------------------------------------------------------- program -- */

function createProgram(): ts.Program {
  const configPath = resolve("tsconfig.json");
  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  if (raw.error) {
    throw new Error(ts.flattenDiagnosticMessageText(raw.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, resolve("."));
  // The snapshot only needs types resolved, never emitted, and `incremental`
  // would race the other tsc runs that share tsconfig.tsbuildinfo.
  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true, incremental: false, composite: false },
  });
}

/* -------------------------------------------------------- type expansion -- */

function isArrayLike(type: ts.Type): boolean {
  const name = type.getSymbol()?.getName();
  return name === "Array" || name === "ReadonlyArray";
}

/** `Promise<T>` -> `T`, and `Promise<Promise<T>>` -> `T`. */
function unwrapPromise(checker: ts.TypeChecker, type: ts.Type): ts.Type {
  let current = type;
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (current.getSymbol()?.getName() !== "Promise") return current;
    const args = checker.getTypeArguments(current as ts.TypeReference);
    if (args.length !== 1) return current;
    current = args[0];
  }
  return current;
}

/**
 * A structural, order-independent rendering of a type.
 *
 * Properties are sorted by name so that reordering a type literal — which
 * changes nothing about what is stored — does not read as a shape change and
 * train everyone to bump the version for no reason. Reordering a *union* is
 * likewise not a change, so those are sorted too.
 */
function expand(
  checker: ts.TypeChecker,
  type: ts.Type,
  node: ts.Node,
  seen: Set<ts.Type>,
  depth: number,
): string {
  if (depth > MAX_DEPTH) return "<max-depth>";

  const flags = type.getFlags();
  if (flags & ts.TypeFlags.Any) return "any";
  if (flags & ts.TypeFlags.Unknown) return "unknown";
  if (flags & ts.TypeFlags.Never) return "never";
  if (flags & ts.TypeFlags.Void) return "void";
  if (flags & ts.TypeFlags.Null) return "null";
  if (flags & ts.TypeFlags.Undefined) return "undefined";
  if (flags & ts.TypeFlags.StringLike) {
    return type.isStringLiteral() ? JSON.stringify(type.value) : "string";
  }
  if (flags & ts.TypeFlags.NumberLike) {
    return type.isNumberLiteral() ? String(type.value) : "number";
  }
  if (flags & ts.TypeFlags.BooleanLike) return "boolean";
  if (flags & ts.TypeFlags.BigIntLike) return "bigint";
  if (flags & ts.TypeFlags.ESSymbolLike) return "symbol";

  if (type.isUnion() || type.isIntersection()) {
    const joiner = type.isUnion() ? " | " : " & ";
    return `(${type.types
      .map((member) => expand(checker, member, node, seen, depth + 1))
      .sort()
      .join(joiner)})`;
  }

  // A cycle, or a type that refers to itself through a property. The category
  // tree does exactly this (children: Category[]).
  if (seen.has(type)) return "<circular>";
  const nested = new Set(seen).add(type);

  if (isArrayLike(type)) {
    const [element] = checker.getTypeArguments(type as ts.TypeReference);
    const inner = element
      ? expand(checker, element, node, nested, depth + 1)
      : (() => {
          const indexed = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
          return indexed ? expand(checker, indexed, node, nested, depth + 1) : "unknown";
        })();
    return `Array<${inner}>`;
  }

  if (type.getCallSignatures().length > 0) {
    // A function inside a cached payload would not survive serialisation
    // anyway, so the identity is enough to notice one appearing.
    return "<function>";
  }

  const properties = checker.getPropertiesOfType(type);
  if (properties.length === 0) {
    const indexed = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    if (indexed) return `{ [key: string]: ${expand(checker, indexed, node, nested, depth + 1)} }`;
    return checker.typeToString(type);
  }

  const rendered = properties
    .map((property) => {
      const propertyType = checker.getTypeOfSymbolAtLocation(property, node);
      const optional = (property.getFlags() & ts.SymbolFlags.Optional) !== 0 ? "?" : "";
      return `${property.getName()}${optional}: ${expand(checker, propertyType, node, nested, depth + 1)}`;
    })
    .sort();

  return `{ ${rendered.join("; ")} }`;
}

/* ------------------------------------------------------------- collection -- */

function readShapeVersion(source: ts.SourceFile): string {
  let found: string | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "SHAPE_VERSION" &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      found = node.initializer.text;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) {
    throw new Error(`Could not find a string SHAPE_VERSION in ${CACHED_MODULE}.`);
  }
  return found;
}

/**
 * Every `cached*` binding in the module, exported or not.
 *
 * Not only the exported ones: `cachedCategoryProducts` is private and is what
 * "you may also like" reads through, so leaving it out would leave a real
 * cached payload unwatched.
 */
function collectShapes(
  checker: ts.TypeChecker,
  source: ts.SourceFile,
): Record<string, string> {
  const shapes: Record<string, string> = {};

  const record = (name: string, node: ts.Node, type: ts.Type): void => {
    const signatures = type.getCallSignatures();
    const returned = signatures.length
      ? checker.getReturnTypeOfSignature(signatures[0])
      : type;
    shapes[name] = expand(checker, unwrapPromise(checker, returned), node, new Set(), 0);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.name.text.startsWith("cached")) {
        record(node.name.text, node, checker.getTypeAtLocation(node.name));
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text.startsWith("cached")) {
      record(node.name.text, node, checker.getTypeAtLocation(node.name));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (Object.keys(shapes).length === 0) {
    throw new Error(
      `Found no cached* bindings in ${CACHED_MODULE}. Either the module moved or ` +
        "this script's naming assumption is stale — either way, do not ignore it.",
    );
  }
  return shapes;
}

function hashOf(shapeVersion: string, shapes: Record<string, string>): string {
  const canonical = Object.keys(shapes)
    .sort()
    .map((name) => `${name} = ${shapes[name]}`)
    .join("\n");
  return createHash("sha256").update(`${shapeVersion}\n${canonical}`).digest("hex").slice(0, 16);
}

/* -------------------------------------------------------------------- run -- */

function main(): void {
  const write = process.argv.includes("--write");

  const program = createProgram();
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(resolve(CACHED_MODULE));
  if (!source) throw new Error(`Could not load ${CACHED_MODULE} into the program.`);

  const shapeVersion = readShapeVersion(source);
  const shapes = collectShapes(checker, source);
  // The hash covers the shapes only. Including the version would make every
  // bump look like a shape change and make the two indistinguishable, which is
  // precisely the distinction this script is here to draw.
  const hash = hashOf("", shapes);

  if (write) {
    const snapshot: Snapshot = { shapeVersion, hash, shapes };
    writeFileSync(SNAPSHOT_FILE, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(
      `Recorded ${Object.keys(shapes).length} cached shapes at ${shapeVersion} (${hash}).`,
    );
    return;
  }

  let previous: Snapshot;
  try {
    previous = JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8")) as Snapshot;
  } catch {
    console.error(
      `No shape snapshot at ${SNAPSHOT_FILE}. Run \`npm run shapes:write\` and commit it.`,
    );
    process.exit(1);
    return;
  }

  if (previous.hash === hash) {
    if (previous.shapeVersion !== shapeVersion) {
      console.error(
        `SHAPE_VERSION moved from ${previous.shapeVersion} to ${shapeVersion} but no cached\n` +
          "shape changed. Either the bump is unnecessary, or the snapshot is stale —\n" +
          "run `npm run shapes:write` to settle it.",
      );
      process.exit(1);
    }
    console.log(`${Object.keys(shapes).length} cached shapes unchanged at ${shapeVersion}.`);
    return;
  }

  const changed = Object.keys({ ...previous.shapes, ...shapes })
    .filter((name) => previous.shapes[name] !== shapes[name])
    .sort();

  if (previous.shapeVersion === shapeVersion) {
    console.error(
      "\nA cached type changed and SHAPE_VERSION did not.\n\n" +
        `  SHAPE_VERSION is still "${shapeVersion}" in ${CACHED_MODULE}.\n\n` +
        "Every entry already on disk keeps its old shape, so the new code will read\n" +
        "objects that are missing the field you just added — silently, with no error\n" +
        "anywhere. That is the Phase 4 `variantId` bug.\n\n" +
        "Changed:\n" +
        changed.map((name) => diffLine(name, previous.shapes[name], shapes[name])).join("\n") +
        `\n\nBump SHAPE_VERSION in ${CACHED_MODULE}, then run \`npm run shapes:write\`.\n`,
    );
    process.exit(1);
  }

  console.error(
    `\nSHAPE_VERSION was bumped to "${shapeVersion}" — good — but the snapshot still\n` +
      `records "${previous.shapeVersion}". Run \`npm run shapes:write\` and commit it, or the\n` +
      "next shape change goes unnoticed.\n\n" +
      "Changed:\n" +
      changed.map((name) => diffLine(name, previous.shapes[name], shapes[name])).join("\n") +
      "\n",
  );
  process.exit(1);
}

/**
 * Enough of the two shapes to see what moved.
 *
 * A shape expands to thousands of characters, and the field that changed is
 * usually buried in the middle of it — so this windows on the point where the
 * two strings first diverge rather than printing the first N characters, which
 * would show identical text twice and be worse than useless.
 */
function diffLine(name: string, before: string | undefined, after: string | undefined): string {
  if (before === undefined) return `  + ${name} (new)`;
  if (after === undefined) return `  - ${name} (removed)`;

  let common = 0;
  while (common < before.length && common < after.length && before[common] === after[common]) {
    common++;
  }
  // Back up to a property boundary so the window starts at a readable place.
  const boundary = Math.max(0, before.lastIndexOf("; ", common) + 2, before.lastIndexOf("{ ", common) + 2);

  return (
    `  ~ ${name}  (diverges at character ${common})\n` +
    `      was: ${window(before, boundary)}\n` +
    `      now: ${window(after, boundary)}`
  );
}

/** 200 characters from the divergence, with an ellipsis on each side that is cut. */
function window(value: string, from: number): string {
  const slice = value.slice(from, from + 200);
  return `${from > 0 ? "…" : ""}${slice}${from + 200 < value.length ? "…" : ""}`;
}

main();
