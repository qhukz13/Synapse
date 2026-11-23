#!/usr/bin/env node
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../apps/web/src/design/tokens.css", import.meta.url), "utf8");
const base = declarations(":root");
const light = new Map([...base, ...declarations(':root[data-theme="light"]')]);

function declarations(selector) {
  const start = css.indexOf(selector + " {");
  if (start === -1) throw new Error("Missing selector " + selector);
  const end = css.indexOf("}", start);
  return new Map(
    [...css.slice(start, end).matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(
      ([, property, value]) => [property, value.trim()],
    ),
  );
}

function luminance(tokens, property, visited = new Set()) {
  if (visited.has(property)) throw new Error("Circular color token " + property);
  visited.add(property);
  const color = tokens.get(property);
  const alias = /^var\((--[\w-]+)\)$/.exec(color ?? "");
  if (alias) return luminance(tokens, alias[1], visited);
  if (!/^#[\da-f]{6}$/i.test(color ?? "")) throw new Error("Invalid color for " + property);
  const channels = color.slice(1).match(/../g).map((pair) => {
    const channel = parseInt(pair, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
}

let checks = 0;
for (const [mode, tokens] of [["dark", base], ["light", light]]) {
  function check(foreground, background, minimum) {
    const a = luminance(tokens, foreground);
    const b = luminance(tokens, background);
    const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    if (ratio < minimum) {
      throw new Error(`${mode} ${foreground} on ${background}: ${ratio.toFixed(2)} < ${minimum}`);
    }
    checks++;
  }
  check("--fg-1", "--bg-1", 13);
  check("--fg-2", "--bg-1", 7);
  check("--accent-fg", "--accent", 4.5);
  const text = ["--fg-1", "--fg-2", "--fg-3", "--accent", "--danger", "--warning", "--success"];
  const glyphs = [...tokens.keys()].filter((key) => /^--(status|domain)-/.test(key));
  for (const surface of ["--bg-0", "--bg-1", "--bg-2", "--bg-3"]) {
    for (const foreground of text) check(foreground, surface, 4.5);
    for (const glyph of glyphs) check(glyph, surface, 3);
  }
}
console.log(`Passed ${checks} token contrast checks across both themes.`);
