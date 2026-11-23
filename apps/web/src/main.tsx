import { vocabulary, confirmTransition } from "@synapse/core/status";
import { createRoot } from "react-dom/client";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useParams,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState } from "react";
import { BookOpen, Compass, Files, Search, ShieldCheck } from "lucide-react";
import type { Catalogue, TopicRow } from "@synapse/core/view";
import type { Issue, Topic } from "@synapse/core";
import { SynapseMark } from "./design/SynapseMark";

import "./workspace.css";

const MarkdownView = lazy(() => import("./markdown/MarkdownView"));
const Editor = lazy(() => import("./Editor"));
const client = new QueryClient();
function query<T>(url: string, enabled = true) {
  return useQuery({
    queryKey: [url],
    enabled,
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/" + url, { signal });
      if (!res.ok)
        throw Error(
          res.status === 404
            ? "This note could not be found."
            : "Synapse could not load this view.",
        );
      return res.json() as Promise<T>;
    },
  });
}
const summary = () =>
  query<Catalogue & { unavailable: string; writeEnabled: boolean }>(
    "index/summary",
  );
function Layout() {
  const navigate = useNavigate();
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        void navigate({ to: "/search" });
      }
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, [navigate]);
  useEffect(() => {
    const events = new EventSource("/api/events");
    const refresh = () => {
      void client.invalidateQueries();
    };
    events.addEventListener("index.changed", refresh);
    events.addEventListener("vault.unavailable", refresh);
    return () => events.close();
  }, []);
  return (
    <div className="studio">
      <nav aria-label="Workspace">
        <div className="brand">
          <SynapseMark size={24} />
          Synapse
        </div>
        <Link to="/">
          <Compass />
          Learning path
        </Link>
        <Link to="/search">
          <Search />
          Search
        </Link>
        <Link to="/library">
          <Files />
          Library
        </Link>
        <Link to="/health">
          <ShieldCheck />
          Vault Health
        </Link>
      </nav>
      <main id="workspace">
        <Outlet />
      </main>
    </div>
  );
}
function Rows({ topics }: { topics: TopicRow[] }) {
  return (
    <ul className="rows">
      {topics.map((t) => (
        <li key={t.slug}>
          <Link to="/t/$slug" params={{ slug: t.slug }}>
            <BookOpen size={16} />
            <span>{t.title}</span>
            <small>{t.status.value || "Not tracked"}</small>
          </Link>
        </li>
      ))}
    </ul>
  );
}
function Curriculum() {
  const result = summary(),
    [filter, setFilter] = useState(""),
    [groupBy, setGroupBy] = useState("path");
  if (!result.data)
    return <p role="status">{result.error?.message ?? "Opening the vault…"}</p>;
  if (result.data.unavailable)
    return <p role="alert">{result.data.unavailable}</p>;
  const groups = new Map<string, TopicRow[]>();
  const matched = result.data.topics.filter((t) =>
    t.title.toLowerCase().includes(filter.toLowerCase()),
  );
  if (groupBy === "path")
    matched.sort(
      (a, b) =>
        (a.position?.index ?? Infinity) - (b.position?.index ?? Infinity),
    );
  for (const t of matched) {
    const stage = result.data.learningPath.stages.find(
      (stage) => stage.number === t.stage,
    );
    const key =
      groupBy === "domain"
        ? t.domain || "Unspecified domain"
        : groupBy === "path" && stage
          ? stage.number + " · " + stage.name
          : t.folder || "Vault";
    const group = groups.get(key) ?? [];
    group.push(t);
    groups.set(key, group);
  }
  return (
    <>
      <header>
        <h1>Learning path</h1>
        <p>Browse {result.data.topics.length} notes in your vault.</p>
      </header>
      <input
        aria-label="Filter topics"
        placeholder="Filter topics"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="view-controls">
        <label>
          Group by{" "}
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
            <option value="path">Learning path</option>
            <option value="folder">Folder</option>
            <option value="domain">Domain</option>
          </select>
        </label>
        <Link to="/roadmap/list">Open as list</Link>
      </div>
      {groups.size === 0 && <p>No matching topics.</p>}
      {[...groups].map(([group, topics]) => (
        <details
          key={group}
          open={
            !!filter || topics.some((t) => t.status.category === "in_progress")
          }
        >
          <summary>
            {group}{" "}
            <small>
              {
                topics.filter((topic) => topic.status.category === "completed")
                  .length
              }
              /{topics.length} completed
            </small>
          </summary>
          <Rows topics={topics} />
        </details>
      ))}
    </>
  );
}
function TopicList() {
  const result = summary(),
    filters = useSearch({ from: "/roadmap/list" }),
    navigate = useNavigate({ from: "/roadmap/list" });
  const topics = result.data?.topics ?? [];
  const domains = [
    ...new Set(topics.map((topic) => topic.domain).filter(Boolean)),
  ].sort();
  const filtered = topics.filter(
    (t) =>
      (!filters.domain || t.domain === filters.domain) &&
      (!filters.status || t.status.value === filters.status) &&
      (!filters.q || t.title.toLowerCase().includes(filters.q.toLowerCase())) &&
      (!filters.ready ||
        ["none", "met"].includes(
          result.data?.prerequisites[t.slug]?.summary ?? "none",
        )),
  );
  filtered.sort((a, b) =>
    filters.sort === "recent"
      ? b.mtimeMs - a.mtimeMs
      : a.title.localeCompare(b.title),
  );
  const update = (patch: Partial<typeof filters>) =>
    void navigate({ search: { ...filters, ...patch }, replace: true });
  return (
    <>
      <header>
        <h1>Curriculum list</h1>
        <Link to="/">Open as tree</Link>
      </header>
      <input
        aria-label="Find a topic"
        placeholder="Find a topic"
        value={filters.q}
        onChange={(e) => update({ q: e.target.value })}
      />
      <div className="view-controls">
        <label>
          Domain{" "}
          <select
            value={filters.domain}
            onChange={(e) => update({ domain: e.target.value })}
          >
            <option value="">All</option>
            {domains.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <label>
          Status{" "}
          <select
            value={filters.status}
            onChange={(e) => update({ status: e.target.value })}
          >
            <option value="">All</option>
            {[
              ...new Set(
                topics.map((topic) => topic.status.value).filter(Boolean),
              ),
            ]
              .sort()
              .map((status) => (
                <option key={status}>{status}</option>
              ))}
          </select>
        </label>
        <label>
          Sort{" "}
          <select
            value={filters.sort}
            onChange={(e) => update({ sort: e.target.value })}
          >
            <option value="title">Title</option>
            <option value="recent">Recently edited</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={filters.ready}
            onChange={(e) => update({ ready: e.target.checked })}
          />
          Prerequisites met
        </label>
      </div>
      {result.error && <p role="alert">{result.error.message}</p>}
      {result.data && filtered.length === 0 && <p>No matching topics.</p>}
      <Rows topics={filtered} />
    </>
  );
}
function StatusControl({ note }: { note: Topic }) {
  const [value, setValue] = useState(note.status.value);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const project = ["project", "course-project"].includes(note.kind);
  const requiresConfirmation =
    project && confirmTransition(note.status.value, value);
  const [confirm, setConfirm] = useState(false);
  async function save() {
    setPending(true);
    setMessage("");
    try {
      const response = await fetch(
        "/api/topics/" + encodeURIComponent(note.slug) + "/meta",
        {
          method: "PATCH",
          headers: { "X-Synapse": "1", "Content-Type": "application/json" },
          body: JSON.stringify({
            baseHash: note.hash,
            set: { status: value },
            expect: { status: note.fm.meta.status },
            confirm,
          }),
        },
      );
      const result = await response.json();
      if (!response.ok) throw Error(result.message);
      await client.invalidateQueries();
      setMessage("Status saved");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Status update failed",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <form
      className="view-controls"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label>
        Status{" "}
        <select
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setConfirm(false);
          }}
        >
          {!vocabulary(note.kind).includes(note.status.value) && (
            <option>{note.status.value}</option>
          )}
          {vocabulary(note.kind).map((status) => (
            <option key={status}>{status}</option>
          ))}
        </select>
      </label>
      {requiresConfirmation && (
        <label>
          <input
            type="checkbox"
            checked={confirm}
            onChange={(e) => setConfirm(e.target.checked)}
          />
          Confirm status change
        </label>
      )}
      <button
        disabled={
          pending ||
          value === note.status.value ||
          (requiresConfirmation && !confirm)
        }
      >
        Save status
      </button>
      {message && <small role="status">{message}</small>}
    </form>
  );
}
function CourseStatus({
  note,
  checkboxHash,
}: {
  note: Topic;
  checkboxHash: string;
}) {
  const [pending, setPending] = useState(false),
    [message, setMessage] = useState("");
  async function toggle() {
    if (!checkboxHash) return;
    setPending(true);
    setMessage("");
    const expectedChecked = note.status.value === "checked";
    try {
      const response = await fetch(
        "/api/topics/" + encodeURIComponent(note.slug) + "/checkbox",
        {
          method: "POST",
          headers: { "X-Synapse": "1", "Content-Type": "application/json" },
          body: JSON.stringify({
            baseHash: checkboxHash,
            offset: note.status.offset,
            expectedChecked,
            checked: !expectedChecked,
          }),
        },
      );
      if (!response.ok) throw Error((await response.json()).message);
      await client.invalidateQueries();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Status update failed",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="view-controls">
      <button
        type="button"
        disabled={pending || !checkboxHash}
        onClick={() => void toggle()}
      >
        {note.status.value === "checked"
          ? "Mark not completed"
          : "Mark completed"}
      </button>
      <small>Stored in Python Course Home</small>
      {message && <span role="status">{message}</span>}
    </div>
  );
}
function FileHistory({ note, writable }: { note: Topic; writable: boolean }) {
  const [open, setOpen] = useState(false),
    [selected, select] = useState(""),
    [confirm, setConfirm] = useState(false),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const [restoreHash, setRestoreHash] = useState("");
  const path = "topics/" + encodeURIComponent(note.slug);
  const history = query<{ id: string; at: number; trigger: string }[]>(
    path + "/history",
    open,
  );
  const backup = query<{ text: string }>(
    path + "/history/" + selected,
    open && !!selected,
  );
  async function restore() {
    setBusy(true);
    try {
      const response = await fetch("/api/" + path + "/restore", {
        method: "POST",
        headers: { "X-Synapse": "1", "Content-Type": "application/json" },
        body: JSON.stringify({
          backupId: selected,
          baseHash: restoreHash,
          confirm: true,
        }),
      });
      if (!response.ok) throw Error((await response.json()).message);
      setMessage("Version restored");
      setConfirm(false);
      select("");
      await client.invalidateQueries();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Restore failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>File history</summary>
      {history.error && <p role="alert">{history.error.message}</p>}
      {history.data?.length === 0 && <p>No saved versions.</p>}
      <ul className="rows">
        {history.data?.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              onClick={() => {
                select(entry.id);
                setRestoreHash(note.hash);
                setConfirm(false);
                setMessage("");
              }}
            >
              {new Date(entry.at).toLocaleString()} · {entry.trigger}
            </button>
          </li>
        ))}
      </ul>
      {backup.error && <p role="alert">{backup.error.message}</p>}
      {backup.data && (
        <>
          <h3>Saved Markdown</h3>
          <pre>{backup.data.text}</pre>
          {writable && (
            <div className="view-controls">
              <label>
                <input
                  type="checkbox"
                  checked={confirm}
                  onChange={(event) => setConfirm(event.target.checked)}
                />
                Replace the current version of {note.title}
              </label>
              <button
                disabled={!confirm || busy}
                onClick={() => void restore()}
              >
                Restore selected version
              </button>
            </div>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
    </details>
  );
}
function Reader() {
  const { slug } = useParams({ from: "/t/$slug" }),
    data = summary(),
    note = query<Topic & { body: string; checkboxHash: string | null }>(
      "topics/" + encodeURIComponent(slug),
    );
  useEffect(() => {
    document.title = (note.data?.title ?? "Reading") + " · Synapse";
    return () => {
      document.title = "Synapse";
    };
  }, [note.data?.title]);
  const n = note.data;
  if (!n) return <p role="status">{note.error?.message ?? "Opening note…"}</p>;
  const prereqs = data.data?.prerequisites[slug];
  const resolveLink = (target: string) => {
    const found = n.links.find(
      (link) => link.target.toLowerCase() === target.toLowerCase(),
    );
    return found?.slug ? "/t/" + encodeURIComponent(found.slug) : undefined;
  };
  return (
    <>
      <div className="crumb reader-crumb">
        <span>
          <Link to="/">Learning path</Link>
          {n.folder && " / " + n.folder}
        </span>
        {data.data?.writeEnabled && (
          <Link to="/t/$slug/edit" params={{ slug }}>
            Edit source
          </Link>
        )}
      </div>
      <header>
        <h1>{n.heading || n.title}</h1>
        <p>
          {[
            n.domain,
            n.status.value || "Not tracked",
            n.readingMinutes + " min read",
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </header>
      {data.data?.writeEnabled &&
        !n.fm.error &&
        n.status.source === "frontmatter" && (
          <StatusControl key={n.slug + n.status.value} note={n} />
        )}
      {data.data?.writeEnabled &&
        n.checkboxHash &&
        n.status.source === "course-checkbox" && (
          <CourseStatus note={n} checkboxHash={n.checkboxHash} />
        )}
      {n.fm.error && (
        <p role="alert">
          Metadata issue on line {n.fm.line}. {n.fm.error}
        </p>
      )}
      {prereqs &&
        (["met", "unmet", "laterInPath", "missing"] as const).some(
          (key) => prereqs[key].length > 0,
        ) && (
          <details>
            <summary>Prerequisites</summary>
            {(["met", "unmet", "laterInPath", "missing"] as const).map(
              (key, i) =>
                prereqs[key].length > 0 && (
                  <div key={key}>
                    <h3>
                      {
                        [
                          "Completed",
                          "Not completed",
                          "Comes later",
                          "Missing",
                        ][i]
                      }
                    </h3>
                    <Rows
                      topics={(data.data?.topics ?? []).filter((t) =>
                        prereqs[key].includes(t.slug),
                      )}
                    />
                    {key === "missing" && (
                      <p>
                        {prereqs[key]
                          .map((s) => s.replace(/^missing:/, ""))
                          .join(", ")}
                      </p>
                    )}
                  </div>
                ),
            )}
          </details>
        )}
      <details>
        <summary>Resources ({n.resources.length})</summary>
        {n.resources.length ? (
          <ul className="rows">
            {n.resources.map((resource, index) => (
              <li key={resource.id + index}>
                <a href={resource.url} target="_blank" rel="noreferrer">
                  {resource.title}
                  <small>{resource.role}</small>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p>This note lists no resources.</p>
        )}
      </details>
      <details>
        <summary>Practice ({n.exercises.length})</summary>
        {n.exercises.length ? (
          <ol>
            {n.exercises.map((item) => (
              <li key={item.section + item.ordinal}>{item.text}</li>
            ))}
          </ol>
        ) : (
          <p>This note has no practice items.</p>
        )}
      </details>
      <FileHistory
        key={slug}
        note={n}
        writable={data.data?.writeEnabled === true}
      />
      <Suspense fallback={<p role="status">Rendering note…</p>}>
        <MarkdownView
          source={n.body.replace(
            /^\s{0,3}(?:\r?\n[ \t]{0,3})*# +[^\r\n]+(?:\r?\n|$)/,
            "",
          )}
          resolveLink={resolveLink}
        />
      </Suspense>
    </>
  );
}
function EditTopic() {
  const { slug } = useParams({ from: "/t/$slug/edit" }),
    settings = summary();
  const source = query<{ text: string; hash: string }>(
    "topics/" + encodeURIComponent(slug) + "/source",
    settings.data?.writeEnabled === true,
  );
  const topic = settings.data?.topics.find((item) => item.slug === slug);
  if (settings.data && !settings.data.writeEnabled)
    return <p role="status">This vault is open in read-only mode.</p>;
  if (!source.data || !topic)
    return (
      <p role="status">
        {source.error?.message ?? settings.error?.message ?? "Opening source…"}
      </p>
    );
  return (
    <>
      <Link to="/t/$slug" params={{ slug }}>
        Back to note
      </Link>
      <Suspense fallback={<p role="status">Loading editor…</p>}>
        <Editor
          key={slug}
          slug={slug}
          title={topic.title}
          source={source.data}
        />
      </Suspense>
    </>
  );
}
function SearchPage() {
  const [value, change] = useState(""),
    result = query<TopicRow[]>(
      "search?q=" + encodeURIComponent(value),
      !!value.trim(),
    );
  return (
    <>
      <h1>Search</h1>
      <input
        aria-label="Search vault"
        type="search"
        value={value}
        onChange={(e) => change(e.target.value)}
        autoFocus
      />
      {result.error && <p role="alert">{result.error.message}</p>}
      {value.trim() && result.data?.length === 0 && <p>No results.</p>}
      <Rows topics={result.data ?? []} />
    </>
  );
}
function Library() {
  const result = query<{ path: string; size: number }[]>("library");
  return (
    <>
      <h1>Library</h1>
      {result.error && <p role="alert">{result.error.message}</p>}
      <ul className="rows">
        {result.data?.map((f) => (
          <li key={f.path}>
            <a
              href={
                "/api/files/" +
                f.path.split("/").map(encodeURIComponent).join("/")
              }
              target="_blank"
              rel="noreferrer"
            >
              {f.path}
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}
function Health() {
  const result = query<Issue[]>("vault-health/issues");
  return (
    <>
      <h1>Vault Health</h1>
      {result.error && <p role="alert">{result.error.message}</p>}
      {result.data?.length === 0 && <p>No issues found.</p>}
      <ul className="issues">
        {result.data?.map((issue) => (
          <li key={issue.id}>
            <strong>
              {issue.severity} · {issue.message}
            </strong>
            <small>
              {issue.path}
              {issue.line ? " · Line " + issue.line : ""}
            </small>
            <p>{issue.why}</p>
          </li>
        ))}
      </ul>
    </>
  );
}
const root = createRootRoute({ component: Layout });
const router = createRouter({
  routeTree: root.addChildren([
    createRoute({
      getParentRoute: () => root,
      path: "/",
      component: Curriculum,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/roadmap/list",
      component: TopicList,
      validateSearch: (value: Record<string, unknown>) => ({
        q: String(value.q ?? ""),
        domain: String(value.domain ?? ""),
        status: String(value.status ?? ""),
        sort: value.sort === "recent" ? "recent" : "title",
        ready: value.ready === true,
      }),
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/search",
      component: SearchPage,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/library",
      component: Library,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/health",
      component: Health,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/t/$slug/edit",
      component: EditTopic,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/t/$slug",
      component: Reader,
    }),
  ]),
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
