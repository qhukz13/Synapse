import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

const grammars = {
  python: () => import("shiki/langs/python.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
};
const aliases: Record<string, string> = {
  py: "python",
  sh: "bash",
  shell: "bash",
  md: "markdown",
  yml: "yaml",
  js: "javascript",
  ts: "typescript",
};
const highlighter = createHighlighterCore({
  themes: [
    import("shiki/themes/github-dark.mjs"),
    import("shiki/themes/github-light.mjs"),
  ],
  langs: [],
  engine: createJavaScriptRegexEngine(),
});

export async function highlight(code: string, language: string) {
  const name = aliases[language] ?? language;
  if (!Object.hasOwn(grammars, name)) return;
  const instance = await highlighter;
  const lang = name as keyof typeof grammars;
  if (!instance.getLoadedLanguages().includes(lang))
    await instance.loadLanguage(await grammars[lang]());
  return instance.codeToTokens(code, {
    lang,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  }).tokens;
}
