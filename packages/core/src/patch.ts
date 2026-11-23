import {
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  type Scalar,
  type YAMLSeq,
} from "yaml";
import { frontmatter } from "./parse/frontmatter";
import { structure } from "./parse/markdown";

export class PatchError extends Error {
  readonly code = "PATCH_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

function unsupported(): never {
  throw new PatchError(
    "Unsupported YAML structure. Edit this file in source mode.",
  );
}

type Value = string | readonly string[];
type Edit = { start: number; end: number; text: string };

function validKey(key: string) {
  if (
    !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ||
    ["__proto__", "constructor", "prototype"].includes(key)
  ) {
    throw new PatchError("Invalid metadata field name.");
  }
}

function header(source: string) {
  const open = /^\uFEFF?---[ \t]*(\r?\n)/.exec(source);
  if (!open) throw new PatchError("This note has no frontmatter.");
  const start = open[0].length;
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(source.slice(start));
  if (!close)
    throw new PatchError(
      "Unterminated frontmatter. Edit this file in source mode.",
    );
  const yaml = source.slice(start, start + close.index);
  const document = parseDocument(yaml, {
    keepSourceTokens: true,
    uniqueKeys: true,
  });
  if (
    document.errors.length ||
    document.warnings.length ||
    !isMap(document.contents) ||
    document.contents.flow ||
    /^\.\.\.[ \t]*(?:#.*)?$/m.test(yaml)
  )
    unsupported();
  visit(document, (_, node) => {
    if (
      isAlias(node) ||
      (node &&
        typeof node === "object" &&
        (("anchor" in node && node.anchor) || ("tag" in node && node.tag)))
    )
      unsupported();
    if (
      isPair(node) &&
      (!isScalar(node.key) ||
        typeof node.key.value !== "string" ||
        node.key.value === "<<" ||
        node.srcToken?.start.some((token) => token.type === "explicit-key-ind"))
    )
      unsupported();
  });
  return { yaml, start, map: document.contents, eol: open[1]! };
}

function encode(value: string, style?: Scalar.Type) {
  if (typeof value !== "string")
    throw new PatchError("Metadata values must be strings.");
  if (style === "QUOTE_SINGLE" && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) {
    return "'" + value.replaceAll("'", "''") + "'";
  }
  if (
    style !== "QUOTE_DOUBLE" &&
    /^[\p{L}\p{N}_][\p{L}\p{M}\p{N}_ ./()-]*$/u.test(value) &&
    value === value.trim()
  ) {
    const parsed = parseDocument(value).contents;
    if (isScalar(parsed) && parsed.value === value) return value;
  }
  return JSON.stringify(value).replace(
    /[\u0085\u2028\u2029]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

function inline(value: Value) {
  if (typeof value === "string") return encode(value);
  if (!Array.isArray(value))
    throw new PatchError("Metadata must be a string or a list of strings.");
  return "[" + value.map((item) => encode(item)).join(", ") + "]";
}

function applyEdits(source: string, edits: Edit[]) {
  let next = source;
  let last = next.length;
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    if (edit.start < 0 || edit.start > edit.end || edit.end > last)
      unsupported();
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
    last = edit.start;
  }
  return next;
}

function lineStart(source: string, offset: number) {
  return source.lastIndexOf("\n", offset - 1) + 1;
}

function stringScalar(node: unknown): Scalar.Parsed {
  if (
    !isScalar(node) ||
    !node.range ||
    typeof node.value !== "string" ||
    node.type === "BLOCK_LITERAL" ||
    node.type === "BLOCK_FOLDED"
  )
    unsupported();
  return node as Scalar.Parsed;
}

function listEdits(
  yaml: string,
  sequence: YAMLSeq,
  value: readonly string[],
  colon: number,
  eol: string,
): Edit[] {
  const old = sequence.items.map(stringScalar);
  const edits: Edit[] = [];
  for (let i = 0; i < Math.min(old.length, value.length); i++) {
    const item = old[i]!;
    if (item.value !== value[i])
      edits.push({
        start: item.range[0],
        end: item.range[1],
        text: encode(value[i]!, item.type),
      });
  }
  if (old.length === value.length) return edits;

  const token = sequence.srcToken;
  if (
    token?.type === "flow-collection" &&
    token.start.type === "flow-seq-start"
  ) {
    const closing = token.end.find((t) => t.type === "flow-seq-end");
    if (!closing) unsupported();
    // Changing the arity of multi-line flow YAML can detach an item comment.
    // Its scalar values may still be changed individually above.
    if (yaml.slice(token.offset, closing.offset).includes("\n")) unsupported();
    if (old.length < value.length) {
      const last = old.at(-1);
      const at = last?.range[1] ?? closing.offset;
      const additions = value
        .slice(old.length)
        .map((s) => encode(s, last?.type))
        .join(", ");
      edits.push({ start: at, end: at, text: (last ? ", " : "") + additions });
    } else {
      const removed = old[value.length]!;
      const comma = token.items[value.length]?.start.find(
        (t) => t.type === "comma",
      );
      const start = comma?.offset ?? removed.range[0];
      const trailing =
        value.length === 0
          ? token.items[old.length]?.start.find((t) => t.type === "comma")
          : undefined;
      const end = trailing ? trailing.offset + 1 : old.at(-1)!.range[1];
      edits.push({ start, end, text: "" });
    }
    return edits;
  }

  if (token?.type !== "block-seq" || !old.length) unsupported();
  for (const item of old) {
    const prefix = yaml.slice(lineStart(yaml, item.range[0]), item.range[0]);
    if (
      !/^ *- +$/.test(prefix) ||
      yaml.slice(item.range[0], item.range[1]).includes("\n")
    )
      unsupported();
  }
  if (value.length < old.length) {
    for (const item of old.slice(value.length)) {
      const start = lineStart(yaml, item.range[0]);
      const newline = yaml.indexOf("\n", item.range[1]);
      if (newline === -1) unsupported();
      const tail = yaml.slice(item.range[1], newline);
      // An inline comment on a removed value stays on its own line.
      const text = tail.includes("#")
        ? /^ */.exec(yaml.slice(start))![0] + tail.trimStart() + "\n"
        : "";
      edits.push({ start, end: newline + 1, text });
    }
    if (!value.length)
      edits.push({ start: colon + 1, end: colon + 1, text: " []" });
  } else {
    const last = old.at(-1)!;
    const prefix = yaml.slice(lineStart(yaml, last.range[0]), last.range[0]);
    const at = yaml.indexOf("\n", last.range[1]) + 1;
    if (at <= 0) unsupported();
    const text = value
      .slice(old.length)
      .map((s) => prefix + encode(s, last.type) + eol)
      .join("");
    edits.push({ start: at, end: at, text });
  }
  return edits;
}

function setField(source: string, key: string, value: Value) {
  validKey(key);
  const { yaml, map, start, eol } = header(source);
  const pair = map.items.find((p) => isScalar(p.key) && p.key.value === key);
  let next: string;
  if (!pair) {
    const first = map.items[0]?.key;
    if (!isScalar(first) || !first.range) unsupported();
    const indent = yaml.slice(lineStart(yaml, first.range[0]), first.range[0]);
    if (!/^ *$/.test(indent)) unsupported();
    next = yaml + indent + key + ": " + inline(value) + eol;
  } else {
    const old = pair.value;
    if (typeof value === "string") {
      const scalar = stringScalar(old);
      if (scalar.value === value) return source;
      next = applyEdits(yaml, [
        {
          start: scalar.range[0],
          end: scalar.range[1],
          text: encode(value, scalar.type),
        },
      ]);
    } else {
      if (!isSeq(old)) unsupported();
      const colon = pair.srcToken?.sep?.find(
        (t) => t.type === "map-value-ind",
      )?.offset;
      if (colon === undefined) unsupported();
      next = applyEdits(yaml, listEdits(yaml, old, value, colon, eol));
    }
  }
  if (next === yaml) return source;
  const patched =
    source.slice(0, start) + next + source.slice(start + yaml.length);
  const verified = header(patched).map;
  if (
    JSON.stringify(verified.get(key, true)?.toJSON()) !== JSON.stringify(value)
  )
    unsupported();
  for (const other of map.items) {
    if (
      isScalar(other.key) &&
      other.key.value !== key &&
      JSON.stringify(map.get(other.key.value, true)?.toJSON()) !==
        JSON.stringify(verified.get(other.key.value, true)?.toJSON())
    )
      unsupported();
  }
  return patched;
}

export function setFrontmatterScalar(
  source: string,
  key: string,
  value: string,
) {
  return setField(source, key, value);
}

export function setFrontmatterList(
  source: string,
  key: string,
  items: readonly string[],
) {
  return setField(source, key, items);
}

export function addFrontmatter(
  source: string,
  fields: Readonly<Record<string, Value>>,
) {
  if (/^\uFEFF?---[ \t]*(?:\r?\n|$)/.test(source))
    throw new PatchError(
      "This note already begins with a frontmatter delimiter.",
    );
  const keys = Object.keys(fields);
  if (!keys.length) throw new PatchError("Select at least one metadata field.");
  const eol = /\r?\n/.exec(source)?.[0] ?? "\n";
  const rows = keys.map((key) => {
    validKey(key);
    return key + ": " + inline(fields[key]!);
  });
  const bom = source.startsWith("\uFEFF") ? 1 : 0;
  const patched =
    source.slice(0, bom) +
    ["---", ...rows, "---", ""].join(eol) +
    source.slice(bom);
  const verified = header(patched).map;
  for (const key of keys)
    if (
      JSON.stringify(verified.get(key, true)?.toJSON()) !==
      JSON.stringify(fields[key])
    )
      unsupported();
  return patched;
}

export function replaceRange(
  source: string,
  start: number,
  end: number,
  expectText: string,
  newText: string,
) {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end > source.length ||
    start > end ||
    source.slice(start, end) !== expectText
  )
    throw new PatchError("The expected text does not match this range.");
  return source.slice(0, start) + newText + source.slice(end);
}

export function toggleCheckbox(
  source: string,
  offset: number,
  expectedChecked: boolean,
  checked: boolean,
) {
  const fm = frontmatter(source);
  if (fm.error)
    throw new PatchError("Correct invalid frontmatter in source mode first.");
  const item = structure(source, fm.bodyStart).exercises.find(
    (e) => e.offset === offset && e.checked !== null,
  );
  if (!item || item.checked !== expectedChecked)
    throw new PatchError("The expected checkbox does not match this location.");
  return item.checked === checked
    ? source
    : replaceRange(
        source,
        offset,
        offset + 1,
        source[offset]!,
        checked ? "x" : " ",
      );
}

export function appendText(source: string, text: string) {
  return source + text;
}
