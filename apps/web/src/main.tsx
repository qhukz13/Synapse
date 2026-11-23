import { createRoot } from "react-dom/client";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useParams,
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
  query<Catalogue & { unavailable: string }>("index/summary");
function Layout() {
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
    [filter, setFilter] = useState("");
  if (!result.data)
    return <p role="status">{result.error?.message ?? "Opening the vault…"}</p>;
  if (result.data.unavailable)
    return <p role="alert">{result.data.unavailable}</p>;
  const groups = new Map<string, TopicRow[]>();
  for (const t of result.data.topics.filter((t) =>
    t.title.toLowerCase().includes(filter.toLowerCase()),
  )) {
    const k = t.folder.split("/")[0] || "Vault";
    groups.set(k, [...(groups.get(k) ?? []), t]);
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
      {groups.size === 0 && <p>No matching topics.</p>}
      {[...groups].map(([group, topics]) => (
        <details
          key={group}
          open={
            !!filter || topics.some((t) => t.status.category === "in_progress")
          }
        >
          <summary>
            {group} <small>{topics.length}</small>
          </summary>
          <Rows topics={topics} />
        </details>
      ))}
    </>
  );
}
function Reader() {
  const { slug } = useParams({ from: "/t/$slug" }),
    data = summary(),
    note = query<Topic & { body: string }>(
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
      <div className="crumb">
        <Link to="/">Learning path</Link> / {n.folder}
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
      <Suspense fallback={<p role="status">Rendering note…</p>}>
        <MarkdownView source={n.body} resolveLink={resolveLink} />
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
