import {
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import "katex/dist/katex.min.css";
import "./reader.css";
import { headingSlug, localHref, obsidian, type ResolveLink } from "./obsidian";
import { youtubeEmbed } from "./video";
import type { highlight } from "./highlight";

export interface MarkdownViewProps {
  source: string;
  resolveLink: ResolveLink;
  resolveAsset?: ResolveLink;
}

const schema: NonNullable<Parameters<typeof rehypeSanitize>[0]> = {
  ...defaultSchema,
  // Only the transform above assigns IDs, each prefixed "heading-". Raw HTML is disabled.
  clobberPrefix: "",
  tagNames: [...(defaultSchema.tagNames ?? []), "details", "summary"],
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-/, "math-inline", "math-display"]],
    details: ["open", ["className", "synapse-callout", /^callout-[\w-]+$/]],
    span: ["title", ["className", "broken-link"]],
    a: [
      ["className", "wiki-link", "data-footnote-backref"],
      ...(defaultSchema.attributes?.a ?? []),
    ],
    img: [
      ...(defaultSchema.attributes?.img ?? []),
      ["className", "wiki-image"],
    ],
  },
};

type Lines = Awaited<ReturnType<typeof highlight>>;
function CodeBlock({ language, code }: { language: string; code: string }) {
  const [lines, setLines] = useState<Lines>();
  useEffect(() => {
    let current = true;
    setLines(undefined);
    if (language && code.length < 100_000) {
      import("./highlight")
        .then(({ highlight }) => highlight(code, language))
        .then((value) => {
          if (current) setLines(value);
        })
        .catch(() => {
          /* Plain text remains readable if a grammar cannot load. */
        });
    }
    return () => {
      current = false;
    };
  }, [code, language]);
  return (
    <div className="synapse-code">
      {language && <div className="code-language">{language}</div>}
      <pre>
        <code>
          {lines
            ? lines.map((line, index) => (
                <span key={index}>
                  {line.map((token, offset) => (
                    <span key={offset} style={token.htmlStyle as CSSProperties}>
                      {token.content}
                    </span>
                  ))}
                  {index < lines.length - 1 && "\n"}
                </span>
              ))
            : code}
        </code>
      </pre>
    </div>
  );
}

function VideoLink({
  url,
  embed,
  children,
}: {
  url: string;
  embed: string;
  children: ReactNode;
}) {
  const [playing, setPlaying] = useState(false);
  return (
    <span className="video-resource">
      <a href={url} target="_blank" rel="noopener noreferrer">
        {children}
      </a>{" "}
      {!playing && (
        <button
          type="button"
          className="video-load"
          onClick={() => setPlaying(true)}
        >
          Load video
        </button>
      )}
      {playing && (
        <iframe
          className="video-frame"
          src={embed}
          title="YouTube resource"
          referrerPolicy="no-referrer"
          allowFullScreen
        />
      )}
    </span>
  );
}

function outbound(url: string) {
  try {
    const link = new URL(url);
    return (
      ["http:", "https:"].includes(link.protocol) &&
      !link.username &&
      !link.password
    );
  } catch {
    return false;
  }
}

export const MarkdownView = memo(function MarkdownView({
  source,
  resolveLink,
  resolveAsset,
}: MarkdownViewProps) {
  const syntax = useMemo(
    () => obsidian(resolveLink, resolveAsset),
    [resolveLink, resolveAsset],
  );
  const components = useMemo<Components>(
    () => ({
      a: ({ href, className, children }) => {
        if (!href) return <span className="broken-link">{children}</span>;
        if (href.startsWith("#"))
          return (
            <a
              href={
                /^#(heading-|user-content-fn)/.test(href)
                  ? href
                  : "#heading-" + headingSlug(href.slice(1))
              }
            >
              {children}
            </a>
          );
        if (outbound(href)) {
          const embed = youtubeEmbed(href);
          return embed ? (
            <VideoLink key={href} url={href} embed={embed}>
              {children}
            </VideoLink>
          ) : (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          );
        }
        // Only a resolved vault link may navigate to an app route.
        const local =
          className === "wiki-link"
            ? localHref(href)
            : localHref(resolveLink(href) ?? resolveAsset?.(href));
        return local ? (
          <a href={local} className={className}>
            {children}
          </a>
        ) : (
          <span className="broken-link" title="Unresolved local link">
            {children}
          </span>
        );
      },
      img: ({ src, alt, className }) => {
        if (typeof src !== "string")
          return <span>{alt || "Image unavailable"}</span>;
        if (outbound(src))
          return (
            <a href={src} target="_blank" rel="noopener noreferrer">
              {alt || "Open external image"}
            </a>
          );
        const url =
          className === "wiki-image"
            ? localHref(src)
            : localHref(resolveAsset?.(src));
        return url ? (
          <img src={url} alt={alt || ""} loading="lazy" />
        ) : (
          <span className="broken-link">{alt || "Image unavailable"}</span>
        );
      },
      pre: ({ children }) => {
        if (
          !isValidElement<{ children?: ReactNode; className?: string }>(
            children,
          ) ||
          typeof children.props.children !== "string"
        ) {
          return <pre>{children}</pre>;
        }
        const language =
          /^language-([\w+-]+)/.exec(children.props.className ?? "")?.[1] ?? "";
        return <CodeBlock code={children.props.children} language={language} />;
      },
      table: ({ children }) => (
        <div className="reader-table">
          <table>{children}</table>
        </div>
      ),
    }),
    [resolveLink, resolveAsset],
  );

  return (
    <div className="synapse-reader markdown-view">
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          syntax,
          [rehypeSanitize, schema],
          [
            rehypeKatex,
            { trust: false, strict: "ignore", maxExpand: 500, maxSize: 20 },
          ],
        ]}
        components={components}
      >
        {source}
      </Markdown>
    </div>
  );
});

export default MarkdownView;
