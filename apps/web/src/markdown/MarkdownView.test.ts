import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "./MarkdownView";
import { localHref } from "./obsidian";
import { youtubeEmbed } from "./video";

function render(source: string) {
  return renderToStaticMarkup(
    createElement(MarkdownView, {
      source,
      resolveLink: (name) => (name === "Вектор" ? "/t/vector" : undefined),
      resolveAsset: (name) =>
        name === "plot.svg" ? "/api/files/plot.svg" : undefined,
    }),
  );
}

describe("vault Markdown", () => {
  it("resolves wiki links and aliases while keeping missing targets visible", () => {
    const html = render("[[Вектор#Форма|подробнее]] · [[Missing|look here]]");
    expect(html).toContain('href="/t/vector#heading-форма"');
    expect(html).toContain("подробнее</a>");
    expect(html).toContain(
      'class="broken-link" title="Missing note: Missing">look here',
    );
  });
  it("keeps inline code, fenced code and math opaque to wiki resolution", () => {
    const html = render(
      '`[[Вектор]]`\n\n```python\nprint("[[Вектор]]")\n```\n\n$x_{1}$\n\n$$\ny=x+1\n$$',
    );
    expect(html).toContain("<code>[[Вектор]]</code>");
    expect(html).toContain('code-language">python');
    expect(html).not.toContain('href="/t/vector"');
    expect(html).toContain('class="katex"');
    expect(html).toContain('class="katex-display"');
  });
  it("renders GFM tables, literal tasks and unique addressable headings", () => {
    const html = render(
      "## Read\n\n## Read\n\n|a|b|\n|-|-|\n|1|2|\n\n- [x] finish",
    );
    expect(html).toContain('id="heading-read"');
    expect(html).toContain('id="heading-read-2"');
    expect(html).toContain("<td>1</td>");
    expect(html).toMatch(/type="checkbox"[^>]*checked/);
  });
  it("preserves both callout title and subsequent inline content", () => {
    const html = render("> [!tip]- Advice\n> Try [[Вектор]] and **review**.");
    expect(html).toContain("<summary>Advice</summary>");
    expect(html).toContain("callout-tip");
    expect(html).not.toContain('open=""');
    expect(html).toContain("<strong>review</strong>");
    expect(html).toContain('href="/t/vector"');
  });
  it("keeps outbound images and videos inert before explicit activation", () => {
    const html = render(
      "![remote](https://example.org/image.png)\n\n[video](https://youtu.be/abcdefghijk)\n\n![[plot.svg|A plot]]",
    );
    expect(html).toContain('href="https://example.org/image.png"');
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toContain("<iframe");
    expect(html).toContain("Load video");
    expect(html).toContain('src="/api/files/plot.svg"');
  });
  it("drops raw HTML and dangerous schemes including through KaTeX", () => {
    const html = render(
      "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert)\n\n$\\href{javascript:alert}{test}$",
    );
    expect(html).not.toMatch(
      /<script|<img |onerror=|href="javascript:|src="javascript:/i,
    );
  });
  it("rejects cross-origin asset results and protocol-relative URLs", () => {
    expect(localHref("//example.net/a")).toBeUndefined();
    expect(localHref("/\\example.net/a")).toBeUndefined();
    expect(localHref("https://example.net/a")).toBeUndefined();
  });
  it("extracts valid YouTube video, playlist and timestamp parameters", () => {
    expect(
      youtubeEmbed(
        "https://www.youtube.com/watch?v=abcdefghijk&list=PL123&t=1m12s",
      ),
    ).toBe(
      "https://www.youtube-nocookie.com/embed/abcdefghijk?list=PL123&start=72",
    );
    expect(youtubeEmbed("https://www.youtube.com/playlist?list=PL123")).toBe(
      "https://www.youtube-nocookie.com/embed/videoseries?list=PL123",
    );
    expect(
      youtubeEmbed("https://youtube.com.example.org/watch?v=abcdefghijk"),
    ).toBeUndefined();
    expect(
      youtubeEmbed("https://user@www.youtube.com/watch?v=abcdefghijk"),
    ).toBeUndefined();
  });
  it("highlights source as inert tokens with dark and light colors", async () => {
    const { highlight } = await import("./highlight");
    const lines = await highlight('print("sample")', "py");
    expect(
      lines
        ?.flatMap((line) => line)
        .map((token) => token.content)
        .join(""),
    ).toBe('print("sample")');
    expect(
      lines
        ?.flat()
        .some((token) => token.htmlStyle && "--shiki-dark" in token.htmlStyle),
    ).toBe(true);
  });
});
