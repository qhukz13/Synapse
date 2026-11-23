import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { EditorView, basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";

const Preview = lazy(() => import("./markdown/MarkdownView"));
interface Props {
  slug: string;
  title: string;
  source: { text: string; hash: string };
}
export default function Editor({ slug, title, source }: Props) {
  const mount = useRef<HTMLDivElement>(null),
    editor = useRef<EditorView | null>(null);
  const [base, setBase] = useState(source),
    [draft, setDraft] = useState(source.text);
  const [showPreview, setShowPreview] = useState(false);
  const [message, setMessage] = useState(""),
    [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{
    hash: string;
    theirs: string;
  } | null>(null);
  useEffect(() => {
    if (!mount.current) return;
    const view = new EditorView({
      parent: mount.current,
      doc: source.text,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": "Markdown source" }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged)
            setDraft(
              update.state.doc
                .toString()
                .replace(/\n/g, base.text.includes("\r\n") ? "\r\n" : "\n"),
            );
        }),
      ],
    });
    editor.current = view;
    return () => {
      view.destroy();
      editor.current = null;
    };
    // Editor state must survive updates after external writes.
  }, []);
  async function save() {
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch(
        "/api/topics/" + encodeURIComponent(slug) + "/source",
        {
          method: "PUT",
          headers: { "X-Synapse": "1", "Content-Type": "application/json" },
          body: JSON.stringify({ text: draft, baseHash: base.hash }),
        },
      );
      const value = await response.json();
      if (response.status === 409 && value.details?.hash) {
        setConflict(value.details);
        setMessage(
          "The file changed on disk. Compare the versions before saving.",
        );
        return;
      }
      if (!response.ok) throw Error(value.message || "Save failed");
      setBase({ text: draft, hash: value.hash });
      setConflict(null);
      setMessage("Saved");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }
  function chooseDisk() {
    if (!conflict || !editor.current) return;
    const view = editor.current;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: conflict.theirs },
    });
    setBase({ text: conflict.theirs, hash: conflict.hash });
    setConflict(null);
    setMessage("Disk version loaded");
  }
  return (
    <>
      <h1>Edit {title}</h1>
      {source.hash !== base.hash && !conflict && (
        <p role="status">The file changed on disk. Your draft is still open.</p>
      )}
      <form
        className="curriculum-editor-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!saving && !conflict && draft !== base.text) void save();
        }}
        onKeyDown={(event) => {
          if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "s"
          ) {
            event.preventDefault();
            event.currentTarget.requestSubmit();
          }
        }}
      >
        <div className={showPreview ? "editor-split" : ""}>
          <div className="source-editor" ref={mount} />
          {showPreview && (
            <Suspense fallback={<p role="status">Rendering preview…</p>}>
              <Preview
                source={draft.replace(
                  /^(?:\uFEFF)?---[^\S\r\n]*\r?\n[\s\S]*?\r?\n---[^\S\r\n]*(?:\r?\n|$)/,
                  "",
                )}
                resolveLink={() => undefined}
              />
            </Suspense>
          )}
        </div>
        <div className="view-controls">
          <button
            type="submit"
            disabled={saving || draft === base.text || !!conflict}
          >
            Save changes
          </button>
          <button
            type="button"
            aria-pressed={showPreview}
            onClick={() => setShowPreview(!showPreview)}
          >
            Preview
          </button>
          <p role="status">{message}</p>
        </div>
      </form>
      {conflict && (
        <section aria-label="Edit conflict">
          <h2>Compare versions</h2>
          <details>
            <summary>Original version</summary>
            <pre>{base.text}</pre>
          </details>
          <details open>
            <summary>Disk version</summary>
            <pre>{conflict.theirs}</pre>
          </details>
          <p>Your draft is still open above.</p>
          <div className="view-controls">
            <button type="button" onClick={chooseDisk}>
              Load disk version
            </button>
            <button
              type="button"
              onClick={() => {
                setBase({ text: conflict.theirs, hash: conflict.hash });
                setConflict(null);
                setMessage(
                  "Draft kept. Review it against the disk version before saving.",
                );
              }}
            >
              Keep draft for review
            </button>
          </div>
        </section>
      )}
    </>
  );
}
