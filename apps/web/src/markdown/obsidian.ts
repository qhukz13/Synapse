import type { ExtraProps } from "react-markdown";

type Element = NonNullable<ExtraProps["node"]>;
type Child = Element["children"][number];
type Parent = Pick<Element, "children">;

export type ResolveLink = (target: string) => string | undefined;

export function localHref(value: string | undefined) {
  if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\"))
    return;
  if ([...value].some((character) => character.charCodeAt(0) < 32)) return;
  return value;
}

export function headingSlug(text: string) {
  return (
    text
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/[\s_]+/g, "-") || "section"
  );
}

function element(
  tagName: string,
  properties: Element["properties"],
  children: Child[],
): Element {
  return { type: "element", tagName, properties, children };
}
function text(value: string): Child {
  return { type: "text", value };
}

function wikiText(
  value: string,
  resolveLink: ResolveLink,
  resolveAsset?: ResolveLink,
): Child[] {
  let offset = 0;
  const children: Child[] = [];
  for (const match of value.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)) {
    const [whole, embed, reference] = match;
    if (reference === undefined) continue;
    if (match.index > offset)
      children.push(text(value.slice(offset, match.index)));
    const [destination = "", alias] = reference.split("|", 2);
    const [target = "", heading] = destination.split("#", 2);
    const caption = alias?.trim() || destination.trim();
    const file = target.trim();
    const asset = localHref(resolveAsset?.(file));
    let href = localHref(resolveLink(file));
    if (heading && (!file || href))
      href = (href ?? "") + "#heading-" + headingSlug(heading);
    if (embed && asset && /\.(png|jpe?g|gif|webp|svg)$/i.test(file)) {
      children.push(
        element(
          "img",
          { src: asset, alt: caption, className: ["wiki-image"] },
          [],
        ),
      );
    } else if (href || asset) {
      children.push(
        element("a", { href: href ?? asset, className: ["wiki-link"] }, [
          text(caption),
        ]),
      );
    } else {
      children.push(
        element(
          "span",
          { className: ["broken-link"], title: "Missing note: " + destination },
          [text(caption)],
        ),
      );
    }
    offset = match.index + whole.length;
  }
  if (offset < value.length) children.push(text(value.slice(offset)));
  return children;
}

function callout(quote: Element) {
  const paragraph = quote.children.find((child) => child.type === "element");
  if (paragraph?.type !== "element" || paragraph.tagName !== "p") return;
  const start = paragraph.children[0];
  if (start?.type !== "text") return;
  const marker = /^\[!([\w-]+)\]([+-]?)[ \t]*/i.exec(start.value);
  if (!marker) return;
  const kind = (marker[1] ?? "note").toLowerCase();
  const title: Child[] = [];
  const rest: Child[] = [];
  let afterTitle = false;
  start.value = start.value.slice(marker[0].length);
  for (const child of paragraph.children) {
    if (afterTitle) rest.push(child);
    else if (child.type === "element" && child.tagName === "br")
      afterTitle = true;
    else if (child.type === "text" && child.value.includes("\n")) {
      const newline = child.value.indexOf("\n");
      title.push(text(child.value.slice(0, newline)));
      rest.push(text(child.value.slice(newline + 1)));
      afterTitle = true;
    } else title.push(child);
  }
  const hasTitle = title.some(
    (child) => child.type !== "text" || child.value.trim(),
  );
  if (!hasTitle) title.push(text(kind[0]!.toUpperCase() + kind.slice(1)));
  paragraph.children = rest;
  quote.tagName = "details";
  quote.properties = {
    className: ["synapse-callout", "callout-" + kind],
    open: marker[2] !== "-",
  };
  quote.children = [
    element("summary", {}, title),
    ...quote.children.filter((child) => child !== paragraph || rest.length > 0),
  ];
}

function plainText(child: Child): string {
  if (child.type === "text") return child.value;
  return child.type === "element" ? child.children.map(plainText).join("") : "";
}

export function obsidian(resolveLink: ResolveLink, resolveAsset?: ResolveLink) {
  return () => (root: Parent) => {
    const used = new Set<string>();
    function walk(parent: Parent) {
      parent.children = parent.children.flatMap((child): Child[] => {
        if (child.type === "text")
          return wikiText(child.value, resolveLink, resolveAsset);
        if (child.type !== "element") return [child];
        if (["code", "pre", "a", "math", "svg"].includes(child.tagName))
          return [child];
        if (child.tagName === "blockquote") callout(child);
        walk(child);
        if (/^h[1-6]$/.test(child.tagName)) {
          const base = "heading-" + headingSlug(plainText(child));
          let id = base;
          for (let suffix = 2; used.has(id); suffix++) id = base + "-" + suffix;
          used.add(id);
          child.properties.id = id;
        }
        return [child];
      });
    }
    walk(root);
  };
}
