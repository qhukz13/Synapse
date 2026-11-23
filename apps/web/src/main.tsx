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
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Compass,
  Files,
  Search,
  ShieldCheck,
  Clock3,
  LayoutDashboard,
  BookmarkCheck,
  ArrowRight,
  FileText,
} from "lucide-react";
import type { Catalogue, TopicRow } from "@synapse/core/view";
import type { Issue, Topic } from "@synapse/core";
import { SynapseMark } from "./design/SynapseMark";

import "./workspace.css";

const MarkdownView = lazy(() => import("./markdown/MarkdownView"));
const Editor = lazy(() => import("./Editor"));
const client = new QueryClient();
function query<T>(url: string, enabled = true, refetchInterval?: number) {
  return useQuery({
    queryKey: [url],
    enabled,
    ...(refetchInterval ? { refetchInterval } : {}),
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
  query<
    Catalogue & {
      unavailable: string;
      writeEnabled: boolean;
      vaultPath: string;
      personalNotesRoot: string;
    }
  >("index/summary");
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
          <LayoutDashboard /> Dashboard
        </Link>
        <Link to="/roadmap/tree">
          <Compass /> Learning path
        </Link>
        <Link to="/search">
          <Search />
          Search
        </Link>
        <Link to="/resources">
          <BookmarkCheck /> Resources
        </Link>
        <Link to="/notes">
          <FileText /> Personal notes
        </Link>
        <Link to="/sessions">
          <Clock3 /> Study sessions
        </Link>
        <Link to="/health">
          <ShieldCheck />
          Vault Health
        </Link>
      </nav>
      <main id="workspace">
        <Outlet />
      </main>
      <StudyTimer />
    </div>
  );
}

type ActiveSession = {
  id: string;
  state: "running" | "paused";
  started_at: number;
  segments: {
    id: number;
    started_at: number;
    ended_at: number | null;
    close_reason: string | null;
  }[];
  segment?: {
    id: number;
    started_at: number;
    ended_at: number | null;
    close_reason: string | null;
  } | null;
} | null;
function StudyTimer() {
  const session = query<ActiveSession>("sessions/current", true, 5000),
    stats = query<{
      todayMs: number;
      streak: { current: number; longest: number };
    }>("stats/study", true, 30_000);
  const [now, setNow] = useState(Date.now());
  const [finishNoteOpen, setFinishNoteOpen] = useState(false);
  const [finishNote, setFinishNote] = useState("");
  const [finishError, setFinishError] = useState("");
  const [finishing, setFinishing] = useState(false);
  const finishDialog = useRef<HTMLDialogElement>(null);
  const lastInput = useRef(Date.now());
  const tabId = useRef(Math.random().toString(36).slice(2));
  const active = session.data;
  useEffect(() => {
    const dialog = finishDialog.current;
    if (!dialog) return;
    if (finishNoteOpen && !dialog.open) dialog.showModal();
    else if (!finishNoteOpen && dialog.open) dialog.close();
  }, [finishNoteOpen]);
  useEffect(() => {
    const channel =
      typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel("synapse-study-activity");
    const receive = (event: MessageEvent) => {
      const at = event.data?.type === "activity" ? event.data.at : NaN;
      if (Number.isFinite(at))
        lastInput.current = Math.max(
          lastInput.current,
          Math.min(Date.now(), at),
        );
    };
    channel?.addEventListener("message", receive);
    const input = () => {
      const at = Date.now();
      lastInput.current = at;
      channel?.postMessage({ type: "activity", at });
    };
    for (const event of ["keydown", "pointerdown", "scroll"])
      window.addEventListener(event, input, { passive: true });
    document.addEventListener("playing", input, true);
    document.addEventListener("timeupdate", input, true);
    return () => {
      for (const event of ["keydown", "pointerdown", "scroll"])
        window.removeEventListener(event, input);
      document.removeEventListener("playing", input, true);
      document.removeEventListener("timeupdate", input, true);
      channel?.removeEventListener("message", receive);
      channel?.close();
    };
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!active || active.state !== "running") return;
    let stopped = false;
    let wakeTimer = 0;
    let wake: (() => void) | undefined;
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        const finish = () => {
          wake = undefined;
          resolve();
        };
        wake = finish;
        wakeTimer = window.setTimeout(finish, ms);
      });
    const beat = async () => {
      try {
        const response = await fetch(`/api/sessions/${active.id}/heartbeat`, {
          method: "POST",
          headers: { "x-synapse": "1", "content-type": "application/json" },
          body: JSON.stringify({ lastInputAt: lastInput.current }),
        });
        if (response.ok) {
          const sessionState = (await response.json()).state;
          await client.invalidateQueries({ queryKey: ["sessions/current"] });
          return sessionState === "running";
        }
      } catch {
        // A transient local request error is retried on the next beat.
      }
      return true;
    };
    const lead = async () => {
      while (!stopped) {
        let acquired = false;
        try {
          await navigator.locks.request(
            "synapse-study-heartbeat",
            { ifAvailable: true },
            async (lock) => {
              if (!lock) return;
              acquired = true;
              while (!stopped && (await beat())) await wait(30_000);
              stopped = true;
            },
          );
        } catch {
          // Fall back to a short-lived localStorage lease below.
          await leaseLead();
          return;
        }
        if (!acquired && !stopped) await wait(5_000);
      }
    };
    const leaseLead = async () => {
      while (!stopped) {
        let owner = false;
        try {
          const key = "synapse-study-heartbeat-lease";
          const existing = JSON.parse(localStorage.getItem(key) ?? "null") as {
            owner: string;
            expires: number;
          } | null;
          if (
            !existing ||
            existing.expires <= Date.now() ||
            existing.owner === tabId.current
          ) {
            localStorage.setItem(
              key,
              JSON.stringify({
                owner: tabId.current,
                expires: Date.now() + 45_000,
              }),
            );
            owner =
              (
                JSON.parse(localStorage.getItem(key) ?? "null") as {
                  owner?: string;
                } | null
              )?.owner === tabId.current;
          }
          if (owner && !(await beat())) {
            stopped = true;
            break;
          }
        } catch {
          // Storage may be disabled; the session still works with this tab's timer.
          await beat();
        }
        await wait(owner ? 30_000 : 5_000);
      }
      try {
        const key = "synapse-study-heartbeat-lease";
        const lease = JSON.parse(localStorage.getItem(key) ?? "null") as {
          owner?: string;
        } | null;
        if (lease?.owner === tabId.current) localStorage.removeItem(key);
      } catch {
        /* storage can be unavailable */
      }
    };
    if (navigator.locks) void lead();
    else void leaseLead();
    return () => {
      stopped = true;
      window.clearTimeout(wakeTimer);
      wake?.();
    };
  }, [active?.id, active?.state]);
  const act = async (
    action: "start" | "pause" | "resume" | "stop",
    note?: string,
  ) => {
    const response =
      action === "start"
        ? await fetch("/api/sessions", {
            method: "POST",
            headers: { "x-synapse": "1", "content-type": "application/json" },
            body: "{}",
          })
        : await fetch(`/api/sessions/${active!.id}/${action}`, {
            method: "POST",
            headers: { "x-synapse": "1", "content-type": "application/json" },
            body: JSON.stringify(note === undefined ? {} : { note }),
          });
    if (response.ok) {
      await client.invalidateQueries();
      lastInput.current = Date.now();
      if (action === "stop") {
        setFinishNoteOpen(false);
        setFinishNote("");
        setFinishError("");
      }
    } else {
      const body = await response.json().catch(() => ({}));
      setFinishError(body.message ?? "Could not finish the study session.");
    }
  };
  const finish = async (note?: string) => {
    setFinishing(true);
    setFinishError("");
    try {
      await act("stop", note);
    } finally {
      setFinishing(false);
    }
  };
  const elapsed =
    active?.segments.reduce(
      (sum, segment) =>
        sum +
        Math.max(
          0,
          (segment.ended_at ??
            (active.state === "running" ? now : segment.started_at)) -
            segment.started_at,
        ),
      0,
    ) ?? 0;
  const format = (ms: number) =>
    `${Math.floor(ms / 3_600_000)
      .toString()
      .padStart(2, "0")}:${Math.floor((ms / 60_000) % 60)
      .toString()
      .padStart(2, "0")}:${Math.floor((ms / 1000) % 60)
      .toString()
      .padStart(2, "0")}`;
  return (
    <footer className="study-timer" aria-label="Study timer">
      <span className="timer-label">
        {active
          ? active.state === "running"
            ? "Studying"
            : "Session paused"
          : "Study session"}
      </span>
      {active?.state === "running" && (
        <output aria-live="off">{format(elapsed)}</output>
      )}
      {stats.data && (
        <span
          className="timer-streak"
          title="A day qualifies for a streak after 10 minutes of recorded study"
        >
          <small>
            {stats.data.streak.current} day streak ·{" "}
            {Math.floor(stats.data.todayMs / 60_000)}m today
          </small>
          <span
            className="timer-streak-track"
            role="progressbar"
            aria-label="Daily streak qualification"
            aria-valuenow={Math.min(100, Math.floor(stats.data.todayMs / 6000))}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span
              style={{
                width: `${Math.min(100, (stats.data.todayMs / 600_000) * 100)}%`,
              }}
            />
          </span>
        </span>
      )}
      {!active && (
        <button onClick={() => void act("start")}>Start session</button>
      )}
      {active?.state === "running" && (
        <>
          <button onClick={() => void act("pause")}>Pause</button>
          <button onClick={() => setFinishNoteOpen(true)}>Finish</button>
        </>
      )}
      {active?.state === "paused" && (
        <>
          <button onClick={() => void act("resume")}>Resume</button>
          <button onClick={() => setFinishNoteOpen(true)}>Finish</button>
        </>
      )}
      {active?.state === "paused" &&
        active.segment?.close_reason === "idle" && (
          <button
            onClick={async () => {
              await fetch(
                `/api/sessions/${active.id}/restore-idle/${active.segment!.id}`,
                {
                  method: "POST",
                  headers: {
                    "x-synapse": "1",
                    "content-type": "application/json",
                  },
                  body: "{}",
                },
              );
              await client.invalidateQueries();
            }}
          >
            Count idle time
          </button>
        )}
      <dialog
        ref={finishDialog}
        className="finish-session-dialog"
        aria-labelledby="finish-session-title"
        onCancel={(event) => {
          event.preventDefault();
          if (!finishing) setFinishNoteOpen(false);
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void finish(finishNote.trim() || undefined);
          }}
        >
          <h2 id="finish-session-title">Wrap up this session</h2>
          <p>Add a short note about what you learned or where to continue.</p>
          <label htmlFor="finish-session-note">Session note</label>
          <textarea
            id="finish-session-note"
            value={finishNote}
            maxLength={2000}
            rows={5}
            placeholder="Key ideas, questions, or the next step…"
            autoFocus
            onChange={(event) => setFinishNote(event.target.value)}
          />
          <small>{finishNote.length}/2000</small>
          {finishError && <p role="alert">{finishError}</p>}
          <div>
            <button
              type="button"
              disabled={finishing}
              onClick={() => setFinishNoteOpen(false)}
            >
              Keep studying
            </button>
            <button
              type="button"
              disabled={finishing}
              onClick={() => void finish()}
            >
              {finishing ? "Finishing…" : "Finish without note"}
            </button>
            <button type="submit" disabled={finishing}>
              {finishing ? "Saving…" : "Save note & finish"}
            </button>
          </div>
        </form>
      </dialog>
    </footer>
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
function TopicSessionAction({ slug }: { slug: string }) {
  const active = query<ActiveSession>("sessions/current");
  if (active.data)
    return (
      <small>
        {active.data.state === "running"
          ? "A study session is active"
          : "A study session is paused"}
      </small>
    );
  return (
    <button
      onClick={async () => {
        const response = await fetch("/api/sessions", {
          method: "POST",
          headers: { "x-synapse": "1", "content-type": "application/json" },
          body: JSON.stringify({ topicSlug: slug }),
        });
        if (response.ok) await client.invalidateQueries();
      }}
    >
      Study this topic
    </button>
  );
}
type SessionRecord = {
  id: string;
  state: string;
  started_at: number;
  ended_at: number | null;
  topic_slug: string | null;
  topic_title: string | null;
  durationMs: number;
  note: string | null;
  segments: {
    id: number;
    started_at: number;
    ended_at: number | null;
    close_reason: string | null;
  }[];
};
function SessionSegmentCorrection({
  sessionId,
  segment,
}: {
  sessionId: string;
  segment: SessionRecord["segments"][number];
}) {
  const [seconds, setSeconds] = useState(1),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const available =
    segment.ended_at === null
      ? 0
      : Math.max(
          0,
          Math.floor((segment.ended_at - segment.started_at - 1) / 1000),
        );
  const correctionSeconds = Math.min(seconds, Math.max(1, available));
  const mutate = async (patch: {
    startAt?: number;
    endAt?: number;
    delete?: boolean;
    confirm?: boolean;
  }) => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(
        `/api/sessions/${sessionId}/segments/${segment.id}/trim`,
        {
          method: "POST",
          headers: { "x-synapse": "1", "content-type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      if (!response.ok)
        throw Error(
          (await response.json()).message ?? "Correction could not be saved.",
        );
      setMessage(
        patch.delete
          ? "Segment removed from recorded study time."
          : "Recorded interval shortened.",
      );
      await client.invalidateQueries({ queryKey: ["sessions"] });
      await client.invalidateQueries({ queryKey: ["stats/study"] });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Correction failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="segment-correction">
      <span>
        {new Date(segment.started_at).toLocaleTimeString()} –{" "}
        {segment.ended_at === null
          ? "still running"
          : new Date(segment.ended_at).toLocaleTimeString()}{" "}
        · {segment.close_reason ?? "active"}
      </span>
      {segment.ended_at !== null && (
        <div className="segment-correction-actions">
          <label>
            Seconds to remove{" "}
            <input
              type="number"
              min={1}
              max={available}
              step={1}
              value={correctionSeconds}
              disabled={!available || busy}
              onChange={(event) =>
                setSeconds(Math.max(1, Number(event.target.value) || 1))
              }
            />
          </label>
          <button
            type="button"
            disabled={!available || busy}
            onClick={() =>
              void mutate({
                startAt: segment.started_at + correctionSeconds * 1000,
              })
            }
          >
            Trim from start
          </button>
          <button
            type="button"
            disabled={!available || busy}
            onClick={() =>
              void mutate({
                endAt: segment.ended_at! - correctionSeconds * 1000,
              })
            }
          >
            Trim from end
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  "Remove this segment from recorded study time? This correction cannot add the time back.",
                )
              )
                void mutate({ delete: true, confirm: true });
            }}
          >
            Remove segment
          </button>
        </div>
      )}
      {message && <small role="status">{message}</small>}
    </div>
  );
}
function StudyHistory() {
  const stats = query<{
    today: string;
    timeZone: string;
    todayMs: number;
    totalMs: number;
    dailyMs: Record<string, number>;
    focusByDomain: { domain: string; ms: number }[];
    streak: { current: number; longest: number };
  }>("stats/study", true, 30_000);
  const sessions = query<SessionRecord[]>("sessions");
  const fmt = (value: number) =>
    `${Math.floor(value / 3_600_000)}h ${Math.floor((value / 60_000) % 60)}m`;
  return (
    <>
      <header>
        <h1>Study sessions</h1>
        <p>
          Recorded focus time · day boundary{" "}
          {stats.data?.timeZone ?? "local timezone"}
        </p>
      </header>
      {stats.data && (
        <section className="session-summary" aria-label="Study totals">
          <div>
            <small>Today</small>
            <strong>{fmt(stats.data.todayMs)}</strong>
          </div>
          <div>
            <small>Current streak</small>
            <strong>{stats.data.streak.current} days</strong>
          </div>
          <div>
            <small>Longest streak</small>
            <strong>{stats.data.streak.longest} days</strong>
          </div>
          <div>
            <small>All time</small>
            <strong>{fmt(stats.data.totalMs)}</strong>
          </div>
        </section>
      )}
      <h2>Recent sessions</h2>
      {sessions.error && <p role="alert">{sessions.error.message}</p>}
      {sessions.data?.length === 0 && (
        <p>
          No study sessions recorded yet. Start a session from a topic or the
          timer.
        </p>
      )}
      <ol className="session-history">
        {sessions.data?.map((item) => (
          <li key={item.id}>
            <span>
              <strong>{item.topic_title ?? "General study"}</strong>
              <small>{new Date(item.started_at).toLocaleString()}</small>
            </span>
            <span>
              {fmt(item.durationMs)}
              <small>{item.state}</small>
            </span>
            {item.note && <p className="session-note">{item.note}</p>}
            {item.segments.length > 0 && (
              <details className="session-corrections">
                <summary>Adjust recorded time</summary>
                <p>
                  Corrections can only shorten or remove recorded intervals.
                </p>
                {item.segments.map((segment) => (
                  <SessionSegmentCorrection
                    key={segment.id}
                    sessionId={item.id}
                    segment={segment}
                  />
                ))}
              </details>
            )}
          </li>
        ))}
      </ol>
      {stats.data && (
        <>
          <h2>Days studied</h2>
          <ul className="study-days">
            {Object.entries(stats.data.dailyMs)
              .sort(([a], [b]) => b.localeCompare(a))
              .slice(0, 14)
              .map(([day, ms]) => (
                <li key={day}>
                  <time dateTime={day}>{day}</time>
                  <span>{fmt(ms)}</span>
                  <small>
                    {ms >= 10 * 60_000
                      ? "Qualifies for streak"
                      : "Below 10 min"}
                  </small>
                </li>
              ))}
          </ul>
        </>
      )}
    </>
  );
}
type ResourceRow = {
  id: string;
  url: string;
  title: string;
  kind: string;
  owners: string[];
  doneAt: number | null;
};
type RecRow = {
  slug: string;
  title: string;
  kind: string;
  stage: number;
  domain: string;
  category: string;
  reasons: string[];
  prerequisiteStatus: {
    met: string[];
    unmet: string[];
    laterInPath: string[];
    missing: string[];
    summary: string;
  };
};
function ResourceStatusButton({ resource }: { resource: ResourceRow }) {
  const mark = async (done: boolean) => {
    const response = await fetch(`/api/resources/${resource.id}/state`, {
      method: "POST",
      headers: { "x-synapse": "1", "content-type": "application/json" },
      body: JSON.stringify({ done }),
    });
    if (response.ok)
      await client.invalidateQueries({ queryKey: ["resources"] });
  };
  return (
    <button
      type="button"
      className="resource-state"
      aria-pressed={!!resource.doneAt}
      onClick={() => void mark(!resource.doneAt)}
    >
      {resource.doneAt
        ? "Completed · mark uncompleted"
        : "Uncompleted · mark completed"}
    </button>
  );
}
function ResourceList({
  resources,
  topics,
}: {
  resources: ResourceRow[];
  topics: TopicRow[];
}) {
  const title = new Map(topics.map((topic) => [topic.slug, topic.title]));
  return (
    <ul className="dashboard-resources">
      {resources.map((resource) => (
        <li key={resource.id}>
          <div>
            <a href={resource.url} target="_blank" rel="noreferrer">
              {resource.title || resource.url} <ArrowRight size={13} />
            </a>
            <small>
              {resource.kind} ·{" "}
              {resource.owners
                .map((owner) => title.get(owner) ?? owner)
                .join(", ")}
            </small>
          </div>
          <ResourceStatusButton resource={resource} />
        </li>
      ))}
    </ul>
  );
}
function ResourcesPage() {
  const result = query<ResourceRow[]>("resources"),
    catalog = summary(),
    [filter, setFilter] = useState(""),
    [state, setState] = useState("all");
  const topics = catalog.data?.topics ?? [];
  const resources = (result.data ?? []).filter(
    (resource) =>
      (!filter ||
        `${resource.title} ${resource.kind} ${resource.owners.map((owner) => topics.find((topic) => topic.slug === owner)?.title ?? owner).join(" ")}`
          .toLowerCase()
          .includes(filter.toLowerCase())) &&
      (state === "all" || (state === "done") === !!resource.doneAt),
  );
  return (
    <>
      <header>
        <h1>Resources</h1>
        <p>
          {result.data?.length ?? 0} distinct links from your curriculum ·
          progress is saved in Synapse
        </p>
      </header>
      <div className="resource-filters">
        <input
          aria-label="Filter resources"
          placeholder="Find a resource or lesson"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <label>
          Status{" "}
          <select
            value={state}
            onChange={(event) => setState(event.target.value)}
          >
            <option value="all">All</option>
            <option value="todo">Uncompleted</option>
            <option value="done">Completed</option>
          </select>
        </label>
        <Link to="/library">
          Browse local files <Files size={15} />
        </Link>
      </div>
      {result.error && <p role="alert">{result.error.message}</p>}
      {resources.length === 0 && <p>No resources match this filter.</p>}
      <ResourceList resources={resources} topics={topics} />
    </>
  );
}
function Dashboard() {
  const catalog = summary(),
    recommendations = query<{
      continue: RecRow[];
      next: RecRow[];
      oneAway: RecRow[];
      all: RecRow[];
    }>("recommendations"),
    stats = query<{
      today: string;
      timeZone: string;
      todayMs: number;
      totalMs: number;
      dailyMs: Record<string, number>;
      focusByDomain: { domain: string; ms: number }[];
      streak: { current: number; longest: number };
    }>("stats/study"),
    resources = query<ResourceRow[]>("resources"),
    sessions = query<SessionRecord[]>("sessions"),
    activity =
      query<{ at: number; kind: string; title: string; slug: string | null }[]>(
        "activity",
      ),
    health = query<Issue[]>("vault-health/issues?severity=error");
  if (catalog.isLoading)
    return (
      <div className="dashboard-loading" aria-label="Loading dashboard">
        <div />
        <div />
        <div />
      </div>
    );
  if (catalog.error || catalog.data?.unavailable)
    return (
      <p role="alert">{catalog.error?.message ?? catalog.data?.unavailable}</p>
    );
  const topics = catalog.data?.topics ?? [],
    recs = recommendations.data;
  const learning = topics.filter((topic) =>
    ["concept", "moc", "intro-moc", "lesson"].includes(topic.kind),
  );
  const completed = learning.filter(
    (topic) => topic.status.category === "completed",
  ).length;
  const stageRows = [
    ...new Set(
      learning.map((topic) => topic.stage).filter((stage) => stage > 0),
    ),
  ]
    .sort((a, b) => a - b)
    .map((stage) => {
      const members = learning.filter((topic) => topic.stage === stage),
        done = members.filter(
          (topic) => topic.status.category === "completed",
        ).length;
      return {
        stage,
        name:
          catalog.data?.learningPath.stages.find(
            (item) => item.number === stage,
          )?.name ?? `Stage ${stage}`,
        total: members.length,
        done,
      };
    });
  const groupedProgress = (
    items: TopicRow[],
    groupName: (topic: TopicRow) => string,
  ) => {
    const groups = new Map<string, TopicRow[]>();
    for (const topic of items) {
      const name = groupName(topic) || "Unassigned";
      groups.set(name, [...(groups.get(name) ?? []), topic]);
    }
    return [...groups]
      .map(([name, members]) => ({
        name,
        total: members.length,
        done: members.filter((topic) => topic.status.category === "completed")
          .length,
        active: members.filter(
          (topic) => topic.status.category === "in_progress",
        ).length,
      }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  };
  const domainProgress = groupedProgress(
      learning,
      (topic) => topic.domain || "Unassigned domain",
    ),
    moduleProgress = groupedProgress(learning, (topic) => topic.folder),
    projects = topics.filter((topic) =>
      ["project", "course-project"].includes(topic.kind),
    ),
    projectProgress = ["not-started", "in-progress", "completed"].map(
      (status) => ({
        name: status,
        total: projects.filter((topic) => topic.status.value === status).length,
      }),
    );
  const current = recs?.continue[0] ?? recs?.next[0],
    next = recs?.next.slice(0, 5) ?? [],
    recentSessions = sessions.data ?? [];
  const recentCompleted = [...learning]
    .filter((topic) => topic.status.category === "completed")
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 2)
    .map((topic) => topic.slug);
  const resourceOwners = [
    ...new Set([
      ...(current ? [current.slug] : []),
      ...recentSessions
        .slice(0, 2)
        .flatMap((session) => (session.topic_slug ? [session.topic_slug] : [])),
      ...recentCompleted,
      ...next.slice(0, 3).map((item) => item.slug),
    ]),
  ];
  const lessonResources = (resources.data ?? [])
    .filter(
      (resource) =>
        !resource.doneAt &&
        resource.owners.some((owner) => resourceOwners.includes(owner)),
    )
    .slice(0, 6);
  const notes = [...topics].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 5);
  const days = stats.data
    ? Array.from({ length: 14 }, (_, index) => {
        const date = new Date(`${stats.data!.today}T00:00:00Z`);
        date.setUTCDate(date.getUTCDate() - (13 - index));
        const day = date.toISOString().slice(0, 10);
        return { day, ms: stats.data!.dailyMs[day] ?? 0 };
      })
    : [];
  const maxDay = Math.max(600_000, ...days.map((day) => day.ms));
  return (
    <div className="dashboard">
      <header className="dashboard-heading">
        <div>
          <p className="eyebrow">YOUR LEARNING SPACE</p>
          <h1>Dashboard</h1>
          <p>
            A clear next step, grounded in your curriculum and study history.
          </p>
        </div>
        <Link className="dashboard-path-link" to="/roadmap/tree">
          Open learning path <ArrowRight size={16} />
        </Link>
      </header>
      {!!health.data?.length && (
        <Link className="health-banner" to="/health">
          <ShieldCheck size={18} />
          {health.data.length} vault error{health.data.length === 1 ? "" : "s"}{" "}
          need review <ArrowRight size={16} />
        </Link>
      )}
      <div className="dashboard-grid">
        <section className="dashboard-panel dash-continue">
          <div className="panel-kicker">PICK UP WHERE YOU LEFT OFF</div>
          <h2>Continue learning</h2>
          {current ? (
            <>
              <Link
                className="continue-title"
                to="/t/$slug"
                params={{ slug: current.slug }}
              >
                {current.title}
                <ArrowRight size={17} />
              </Link>
              <p>
                {current.domain || `Stage ${current.stage}`} ·{" "}
                {current.category === "in_progress"
                  ? "In progress"
                  : "Suggested next lesson"}
              </p>
              <div className="continue-reasons">
                {current.reasons.map((reason) => (
                  <span key={reason}>{reason}</span>
                ))}
              </div>
              <Link
                className="primary-action"
                to="/t/$slug"
                params={{ slug: current.slug }}
              >
                Open lesson
              </Link>
            </>
          ) : (
            <>
              <p>
                You’ve completed every currently recommended learning topic.
              </p>
              <Link to="/roadmap/tree">Explore the curriculum</Link>
            </>
          )}
        </section>
        <section className="dashboard-panel dash-today">
          <div className="panel-kicker">TODAY</div>
          <h2>Your study rhythm</h2>
          {stats.data && (
            <>
              <div className="today-time">
                {Math.floor(stats.data.todayMs / 60_000)}
                <small>min studied</small>
              </div>
              <div
                className="goal-track"
                role="progressbar"
                aria-label="Ten minute streak goal"
                aria-valuenow={Math.min(
                  100,
                  Math.floor(stats.data.todayMs / 6000),
                )}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <span
                  style={{
                    width: `${Math.min(100, (stats.data.todayMs / 600_000) * 100)}%`,
                  }}
                />
              </div>
              <small>
                {stats.data.todayMs >= 600_000
                  ? "Daily streak goal reached"
                  : "10 min qualifies this day for a streak"}
              </small>
              <div className="streak-stats">
                <span>
                  <strong>{stats.data.streak.current}</strong> current streak
                </span>
                <span>
                  <strong>{stats.data.streak.longest}</strong> longest
                </span>
              </div>
            </>
          )}
        </section>
        <section className="dashboard-panel dash-next">
          <div className="panel-heading">
            <div>
              <div className="panel-kicker">RECOMMENDED</div>
              <h2>Next lessons</h2>
            </div>
            <Link to="/roadmap/list">
              All topics <ArrowRight size={14} />
            </Link>
          </div>
          <p className="muted">
            Prerequisites help order suggestions. Every topic remains open to
            you.
          </p>
          {next.length ? (
            <ol className="next-lessons">
              {next.map((item, index) => (
                <li key={item.slug}>
                  <span className="next-number">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <Link to="/t/$slug" params={{ slug: item.slug }}>
                      {item.title}
                    </Link>
                    <small>{item.reasons.join(" · ")}</small>
                    {item.prerequisiteStatus.unmet.length > 0 && (
                      <small className="prereq-notice">
                        Suggested first:{" "}
                        {item.prerequisiteStatus.unmet
                          .slice(0, 2)
                          .map(
                            (slug) =>
                              topics.find((topic) => topic.slug === slug)
                                ?.title ?? slug,
                          )
                          .join(", ")}
                      </small>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p>No unfinished lessons found.</p>
          )}
        </section>
        <section className="dashboard-panel dash-resources">
          <div className="panel-heading">
            <div>
              <div className="panel-kicker">FROM YOUR LESSONS</div>
              <h2>Resources to check out</h2>
            </div>
            <Link to="/resources">
              Library <ArrowRight size={14} />
            </Link>
          </div>
          <p className="muted">
            Links from your current, recently studied, completed, and next
            lessons.
          </p>
          {lessonResources.length ? (
            <ResourceList resources={lessonResources} topics={topics} />
          ) : (
            <p>
              No uncompleted resources are linked to those lessons. Browse the
              full resource library.
            </p>
          )}
        </section>
        <section className="dashboard-panel dash-progress">
          <div className="panel-heading">
            <div>
              <div className="panel-kicker">CURRICULUM</div>
              <h2>Learning progress</h2>
            </div>
            <Link to="/roadmap/list">
              Explore <ArrowRight size={14} />
            </Link>
          </div>
          <div className="overall-progress">
            <strong>
              {completed}
              <span> / {learning.length}</span>
            </strong>
            <small>learning topics completed</small>
            <div className="goal-track">
              <span
                style={{
                  width: `${learning.length ? (completed / learning.length) * 100 : 0}%`,
                }}
              />
            </div>
          </div>
          <div className="stage-progress">
            {stageRows.map((row) => (
              <div className="stage-row" key={row.stage}>
                <span>
                  Stage {row.stage} · {row.name}
                </span>
                <small>
                  {row.done}/{row.total}
                </small>
                <div className="goal-track">
                  <span
                    style={{
                      width: `${row.total ? (row.done / row.total) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
          <details className="progress-rollups">
            <summary>Domain, module & project rollups</summary>
            <div className="rollup-columns">
              {[
                { title: "By domain", rows: domainProgress },
                { title: "By module", rows: moduleProgress },
              ].map((group) => (
                <section key={group.title}>
                  <h3>{group.title}</h3>
                  <ul>
                    {group.rows.map((row) => (
                      <li key={row.name}>
                        <span>{row.name}</span>
                        <small>
                          {row.done}/{row.total} complete · {row.active} active
                        </small>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              <section>
                <h3>Projects by status</h3>
                <ul>
                  {projectProgress.map((row) => (
                    <li key={row.name}>
                      <span>{row.name}</span>
                      <small>{row.total}</small>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          </details>
        </section>
        <section className="dashboard-panel dash-study">
          <div className="panel-heading">
            <div>
              <div className="panel-kicker">LAST 14 DAYS</div>
              <h2>Study time</h2>
            </div>
            <Link to="/sessions">
              History <ArrowRight size={14} />
            </Link>
          </div>
          <div className="study-bars">
            {days.map((item) => (
              <div
                className="study-bar-day"
                key={item.day}
                title={`${item.day}: ${Math.floor(item.ms / 60_000)} minutes`}
              >
                <span
                  className={item.ms >= 600_000 ? "qualifies" : ""}
                  style={{
                    height: `${Math.max(item.ms ? 4 : 1, (item.ms / maxDay) * 100)}%`,
                  }}
                />
                <small>{item.day.slice(8)}</small>
              </div>
            ))}
          </div>
          <small>
            Outlined days meet the 10 minute streak threshold ·{" "}
            {stats.data?.timeZone}
          </small>
          {!!stats.data?.focusByDomain.length && (
            <div className="focus-rollup">
              <h3>Focus by domain</h3>
              <ul>
                {stats.data.focusByDomain.slice(0, 5).map((item) => {
                  const maximum = stats.data!.focusByDomain[0]!.ms;
                  return (
                    <li key={item.domain}>
                      <span>{item.domain}</span>
                      <span className="focus-track">
                        <span
                          style={{
                            width: `${maximum ? (item.ms / maximum) * 100 : 0}%`,
                          }}
                        />
                      </span>
                      <small>{Math.floor(item.ms / 60_000)}m</small>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>
        <section className="dashboard-panel dash-activity">
          <div className="panel-heading">
            <div>
              <div className="panel-kicker">YOUR RECENT WORK</div>
              <h2>Recent activity</h2>
            </div>
            <Link to="/sessions">
              Sessions <ArrowRight size={14} />
            </Link>
          </div>
          {activity.data?.length ? (
            <ul className="activity-list">
              {activity.data.slice(0, 6).map((item, index) => (
                <li key={`${item.kind}-${item.at}-${index}`}>
                  <span className={`activity-dot ${item.kind}`} />
                  <div>
                    {item.slug ? (
                      <Link to="/t/$slug" params={{ slug: item.slug }}>
                        {item.title}
                      </Link>
                    ) : (
                      <strong>{item.title}</strong>
                    )}
                    <small>
                      {item.kind.replace("-", " ")} ·{" "}
                      {new Date(item.at).toLocaleString()}
                    </small>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p>
              No recent activity yet. Your study sessions and curriculum changes
              will appear here.
            </p>
          )}
        </section>
        <section className="dashboard-panel dash-edited">
          <div className="panel-heading">
            <div>
              <div className="panel-kicker">VAULT NOTES</div>
              <h2>Recently edited</h2>
            </div>
            <Link to="/roadmap/tree">
              Browse <ArrowRight size={14} />
            </Link>
          </div>
          <ul className="recent-notes">
            {notes.map((note) => (
              <li key={note.slug}>
                <Link to="/t/$slug" params={{ slug: note.slug }}>
                  <BookOpen size={14} />
                  <span>
                    {note.title}
                    <small>{note.domain || note.folder}</small>
                  </span>
                </Link>
                <small>{new Date(note.mtimeMs).toLocaleDateString()}</small>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
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
        <p>
          {result.data.topics.length} Markdown files ·{" "}
          {result.data.writeEnabled ? "Editing enabled" : "Read-only"}
        </p>
        <p className="vault-path" title={result.data.vaultPath}>
          {result.data.vaultPath}
        </p>
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
        <Link to="/roadmap/tree">Open as tree</Link>
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
function Properties({ note, topics }: { note: Topic; topics: TopicRow[] }) {
  const entries = Object.entries(note.fm.meta);
  if (!entries.length)
    return (
      <details open>
        <summary>Properties</summary>
        <p>
          {note.fm.error
            ? "The frontmatter could not be read."
            : "This file has no frontmatter properties."}
        </p>
      </details>
    );
  function display(value: unknown) {
    if (typeof value === "string") {
      const target = value.replace(/^\[\[(.*?)\]\]$/, "$1");
      const match = topics.find(
        (topic) => topic.title.toLowerCase() === target.toLowerCase(),
      );
      if (match)
        return (
          <Link to="/t/$slug" params={{ slug: match.slug }}>
            {value}
          </Link>
        );
      return value || <em>Empty string</em>;
    }
    if (value === null) return "null";
    if (typeof value === "object") return <code>{JSON.stringify(value)}</code>;
    return String(value);
  }
  return (
    <details open>
      <summary>Properties ({entries.length})</summary>
      <dl className="note-properties">
        {entries.map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>
              {Array.isArray(value) ? (
                value.length ? (
                  <ul>
                    {value.map((item, index) => (
                      <li key={index}>{display(item)}</li>
                    ))}
                  </ul>
                ) : (
                  <code>[]</code>
                )
              ) : (
                display(value)
              )}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
type PracticeData = {
  exercises: (Topic["exercises"][number] & {
    done: boolean;
    source: "app" | "markdown";
  })[];
  orphans: {
    fingerprint: string;
    section: string;
    ordinal: number;
    text_snapshot: string;
    done_at: number;
  }[];
};
function PracticePanel({
  note,
  checkboxHash,
  writable,
}: {
  note: Topic;
  checkboxHash: string | null;
  writable: boolean;
}) {
  const result = query<PracticeData>(
    "practice/" + encodeURIComponent(note.slug),
    note.exercises.length > 0,
  );
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  const items = result.data?.exercises ?? [];
  const toggle = async (
    item: PracticeData["exercises"][number],
    done: boolean,
  ) => {
    setPending(item.fingerprint);
    setError("");
    setOptimistic((current) => ({ ...current, [item.fingerprint]: done }));
    try {
      const response =
        item.source === "markdown"
          ? await fetch(
              `/api/topics/${encodeURIComponent(note.slug)}/checkbox`,
              {
                method: "POST",
                headers: {
                  "x-synapse": "1",
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  baseHash: note.hash,
                  offset: item.offset!,
                  checked: done,
                  expectedChecked: item.done,
                }),
              },
            )
          : await fetch(`/api/practice/${encodeURIComponent(note.slug)}`, {
              method: "POST",
              headers: { "x-synapse": "1", "content-type": "application/json" },
              body: JSON.stringify({ fingerprint: item.fingerprint, done }),
            });
      if (!response.ok) {
        const payload = await response.json();
        throw Error(payload.message ?? "Exercise progress could not be saved.");
      }
      await client.invalidateQueries({
        queryKey: ["practice/" + encodeURIComponent(note.slug)],
      });
      if (item.source === "markdown") {
        await client.invalidateQueries({
          queryKey: ["topics/" + encodeURIComponent(note.slug)],
        });
      }
      setOptimistic((current) => {
        const next = { ...current };
        delete next[item.fingerprint];
        return next;
      });
    } catch (cause) {
      setOptimistic((current) => {
        const next = { ...current };
        delete next[item.fingerprint];
        return next;
      });
      setError(
        cause instanceof Error
          ? cause.message
          : "Exercise progress could not be saved.",
      );
    } finally {
      setPending(null);
    }
  };
  if (!note.exercises.length) return null;
  const isDone = (item: PracticeData["exercises"][number]) =>
    optimistic[item.fingerprint] ?? item.done;
  const completed = items.filter(isDone).length;
  return (
    <details>
      <summary>
        Practice ({completed}/{note.exercises.length} complete)
      </summary>
      {result.error && <p role="alert">{result.error.message}</p>}
      <ol className="practice-list">
        {items.map((item) => (
          <li key={`${item.section}-${item.ordinal}-${item.fingerprint}`}>
            <label>
              <input
                type="checkbox"
                checked={isDone(item)}
                disabled={
                  pending !== null ||
                  (item.source === "markdown" && (!writable || !checkboxHash))
                }
                aria-label={`Complete exercise: ${item.text}`}
                onChange={(event) => void toggle(item, event.target.checked)}
              />
              <span>{item.text}</span>
            </label>
            <small>{item.section}</small>
          </li>
        ))}
      </ol>
      {items.some((item) => item.source === "markdown" && !writable) && (
        <small>
          Markdown checkboxes are disabled while this vault is read-only.
        </small>
      )}
      {error && <p role="alert">{error}</p>}
      {!!result.data?.orphans.length && (
        <details className="exercise-orphans">
          <summary>Changed or removed ({result.data.orphans.length})</summary>
          <ul>
            {result.data.orphans.map((item) => (
              <li key={item.fingerprint}>
                {item.text_snapshot}
                <small>{item.section}</small>
              </li>
            ))}
          </ul>
        </details>
      )}
    </details>
  );
}
function Reader() {
  const { slug } = useParams({ from: "/t/$slug" }),
    data = summary(),
    note = query<Topic & { body: string; checkboxHash: string | null }>(
      "topics/" + encodeURIComponent(slug),
    ),
    personalNotes = query<PersonalNoteRow[]>(
      `personal-notes?aboutSlug=${encodeURIComponent(slug)}`,
    );
  useEffect(() => {
    document.title = (note.data?.title ?? "Reading") + " · Synapse";
    return () => {
      document.title = "Synapse";
    };
  }, [note.data?.title]);
  const n = note.data;
  if (!n) return <p role="status">{note.error?.message ?? "Opening note…"}</p>;
  const hasLeadingHeading =
    /^\s{0,3}(?:\r?\n[ \t]{0,3})*# +[^\r\n]+(?:\r?\n|$)/.test(n.body);
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
          <Link to="/roadmap/tree">Learning path</Link>
          {n.folder && " / " + n.folder}
        </span>
        {data.data?.writeEnabled && (
          <Link to="/t/$slug/edit" params={{ slug }}>
            Edit source
          </Link>
        )}
      </div>
      <header>
        {!hasLeadingHeading && <h1>{n.heading || n.title}</h1>}
        <TopicSessionAction slug={slug} />
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
      <Properties key={slug} note={n} topics={data.data?.topics ?? []} />
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
      {n.kind !== "note" && (
        <details>
          <summary>Personal notes ({personalNotes.data?.length ?? 0})</summary>
          {personalNotes.data?.length ? (
            <ul className="rows">
              {personalNotes.data.map((personalNote) => (
                <li key={personalNote.slug}>
                  <Link to="/notes/$slug" params={{ slug: personalNote.slug }}>
                    {personalNote.title}
                    <small>{personalNote.path}</small>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p>No personal notes are associated with this topic.</p>
          )}
          <Link to="/notes">Open personal notes</Link>
        </details>
      )}
      <PracticePanel
        note={n}
        checkboxHash={n.checkboxHash}
        writable={data.data?.writeEnabled === true}
      />
      <FileHistory
        key={slug}
        note={n}
        writable={data.data?.writeEnabled === true}
      />
      <Suspense fallback={<p role="status">Rendering note…</p>}>
        <MarkdownView source={n.body} resolveLink={resolveLink} />
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
type PersonalNoteRow = {
  slug: string;
  title: string;
  path: string;
  scope: string;
  domain: string;
  stage: number;
  hash: string;
  mtimeMs: number;
};
function PersonalNotesPage() {
  const access = summary();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState("all");
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [newScope, setNewScope] = useState<"general" | "topic" | "project">(
    "topic",
  );
  const [aboutSlug, setAboutSlug] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const notes = query<PersonalNoteRow[]>(
    `personal-notes?q=${encodeURIComponent(q)}${scope !== "all" ? `&scope=${scope}` : ""}`,
  );
  const owners = (access.data?.topics ?? []).filter((topic) =>
    newScope === "project"
      ? ["project", "course-project"].includes(topic.kind)
      : !["project", "course-project", "note"].includes(topic.kind),
  );
  const selectedOwner = owners.find((item) => item.slug === aboutSlug);
  const rootPath = access.data?.personalNotesRoot ?? "Personal Notes";
  const pathPreview =
    newScope === "general"
      ? `${rootPath}/General/${title || "<title>"}.md`
      : `${rootPath}/${newScope === "project" ? "Projects" : "Topics"}/${(selectedOwner?.title ?? "<item>").replace(/[\\/]/g, " - ")}/${title || "<title>"}.md`;
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/personal-notes", {
        method: "POST",
        headers: { "x-synapse": "1", "content-type": "application/json" },
        body: JSON.stringify({
          title,
          scope: newScope,
          ...(newScope === "general" ? {} : { aboutSlug }),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.message ?? "Could not create note.");
      await client.invalidateQueries({ queryKey: ["personal-notes"] });
      setCreating(false);
      setTitle("");
      if (result.slug)
        void navigate({ to: "/notes/$slug", params: { slug: result.slug } });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not create note.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <header className="notes-heading">
        <div>
          <p className="eyebrow">YOUR MARKDOWN</p>
          <h1>Personal notes</h1>
          <p>
            Notes stay in your vault. Synapse indexes them without storing note
            text in SQLite.
          </p>
        </div>
        {access.data?.writeEnabled && (
          <button type="button" onClick={() => setCreating((open) => !open)}>
            {creating ? "Cancel" : "New note"}
          </button>
        )}
      </header>
      {!access.data?.writeEnabled && (
        <p className="read-only-banner">
          This vault is open read-only. Enable writes in local configuration to
          create notes.
        </p>
      )}
      {creating && (
        <form
          className="new-note-form"
          onSubmit={(event) => void create(event)}
        >
          <label>
            Title
            <input
              value={title}
              maxLength={200}
              required
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            Scope
            <select
              value={newScope}
              onChange={(event) =>
                setNewScope(event.target.value as typeof newScope)
              }
            >
              <option value="topic">Topic</option>
              <option value="project">Project</option>
              <option value="general">General</option>
            </select>
          </label>
          {newScope !== "general" && (
            <label>
              {newScope === "project" ? "Project" : "Topic"}
              <select
                value={aboutSlug}
                required
                onChange={(event) => setAboutSlug(event.target.value)}
              >
                <option value="">Choose…</option>
                {owners.map((owner) => (
                  <option key={owner.slug} value={owner.slug}>
                    {owner.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <small>Creates at {pathPreview}</small>
          {error && <p role="alert">{error}</p>}
          <button
            type="submit"
            disabled={
              busy || !title.trim() || (newScope !== "general" && !aboutSlug)
            }
          >
            {busy ? "Creating…" : "Create note"}
          </button>
        </form>
      )}
      <div className="notes-filters">
        <input
          type="search"
          aria-label="Search personal notes"
          placeholder="Search note content…"
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
        <select
          aria-label="Filter by scope"
          value={scope}
          onChange={(event) => setScope(event.target.value)}
        >
          <option value="all">All scopes</option>
          <option value="general">General</option>
          <option value="topic">Topic</option>
          <option value="project">Project</option>
          <option value="legacy">Legacy locations</option>
        </select>
      </div>
      {notes.error && <p role="alert">{notes.error.message}</p>}
      {notes.data?.length ? (
        <ul className="personal-note-list">
          {notes.data.map((note) => (
            <li key={note.slug}>
              <Link to="/notes/$slug" params={{ slug: note.slug }}>
                <FileText size={16} />
                <span>
                  {note.title}
                  <small>
                    {note.scope} · {note.domain || note.path}
                  </small>
                </span>
                <small>{new Date(note.mtimeMs).toLocaleDateString()}</small>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p>
          {q ? "No notes match this search." : "No notes found for this scope."}
        </p>
      )}
    </>
  );
}
function PersonalNotePage() {
  const { slug } = useParams({ from: "/notes/$slug" });
  const access = summary();
  const note = query<{
    slug: string;
    title: string;
    path: string;
    hash: string;
    text: string;
    about: string[];
  }>(`personal-notes/${encodeURIComponent(slug)}`);
  const [draft, setDraft] = useState<string | null>(null);
  const [baseHash, setBaseHash] = useState("");
  const [lastSaved, setLastSaved] = useState("");
  const [state, setState] = useState("Saved");
  const [conflict, setConflict] = useState<{
    hash: string;
    theirs: string;
  } | null>(null);
  useEffect(() => {
    if (note.data && draft === null) {
      setDraft(note.data.text);
      setBaseHash(note.data.hash);
      setLastSaved(note.data.text);
    }
  }, [note.data, draft]);
  const save = async (text: string, expectedHash = baseHash) => {
    setState("Saving…");
    const response = await fetch(
      `/api/personal-notes/${encodeURIComponent(slug)}`,
      {
        method: "PUT",
        headers: { "x-synapse": "1", "content-type": "application/json" },
        body: JSON.stringify({ baseHash: expectedHash, text }),
      },
    );
    const result = await response.json();
    if (response.status === 409 && result.details?.theirs) {
      setConflict({ hash: result.details.hash, theirs: result.details.theirs });
      setState("Conflict needs review");
      return;
    }
    if (!response.ok) {
      setState(result.message ?? "Save failed");
      return;
    }
    setBaseHash(result.hash);
    setLastSaved(text);
    setState("Saved");
    setConflict(null);
  };
  useEffect(() => {
    if (
      !draft ||
      !baseHash ||
      draft === lastSaved ||
      conflict ||
      !access.data?.writeEnabled
    )
      return;
    setState("Unsaved changes");
    const timer = window.setTimeout(() => void save(draft), 700);
    return () => window.clearTimeout(timer);
  }, [draft, baseHash, lastSaved, conflict, access.data?.writeEnabled]);
  useEffect(() => {
    if (
      !draft ||
      !baseHash ||
      draft === lastSaved ||
      conflict ||
      !access.data?.writeEnabled
    )
      return;
    const flush = () => {
      void fetch(`/api/personal-notes/${encodeURIComponent(slug)}`, {
        method: "PUT",
        headers: { "x-synapse": "1", "content-type": "application/json" },
        body: JSON.stringify({ baseHash, text: draft }),
        keepalive: true,
      }).catch(() => {});
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [slug, draft, baseHash, lastSaved, conflict, access.data?.writeEnabled]);
  if (!note.data || draft === null)
    return <p role="status">{note.error?.message ?? "Opening note…"}</p>;
  return (
    <>
      <div className="crumb">
        <Link to="/notes">Personal notes</Link> / {note.data.path}
        {note.data.about.map((owner) => {
          const target = access.data?.topics.find(
            (item) => item.slug === owner,
          );
          return target ? (
            <span key={owner}>
              {" · "}
              <Link to="/t/$slug" params={{ slug: owner }}>
                {target.title}
              </Link>
            </span>
          ) : null;
        })}
      </div>
      <header className="personal-note-heading">
        <div>
          <h1>{note.data.title}</h1>
          <p>{note.data.path}</p>
        </div>
        <small role="status">
          {access.data?.writeEnabled ? state : "Read-only"}
        </small>
      </header>
      {conflict && (
        <section className="note-conflict" role="alert">
          <h2>This note changed outside Synapse</h2>
          <p>
            Your draft is still here. Review the current vault version before
            replacing it.
          </p>
          <details>
            <summary>Current vault version</summary>
            <pre>{conflict.theirs}</pre>
          </details>
          <div>
            <button
              type="button"
              onClick={() => {
                setDraft(conflict.theirs);
                setLastSaved(conflict.theirs);
                setBaseHash(conflict.hash);
                setConflict(null);
                setState("Loaded external version");
              }}
            >
              Load external version
            </button>
            <button
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    "Replace the external version with your draft?",
                  )
                )
                  void save(draft, conflict.hash);
              }}
            >
              Replace external with my draft
            </button>
          </div>
        </section>
      )}
      <label
        className="personal-note-editor-label"
        htmlFor="personal-note-editor"
      >
        Markdown note
      </label>
      <textarea
        id="personal-note-editor"
        className="personal-note-editor"
        value={draft}
        readOnly={!access.data?.writeEnabled}
        onChange={(event) => setDraft(event.target.value)}
      />
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
type RepairPreview = {
  issueId: string;
  path: string;
  evidence: string;
  before: string;
  after: string;
  baseHash: string;
  afterHash: string;
  targetPath?: string;
  edits?: { difficulty?: string; importance?: string };
};
type RepairHistory = {
  id: string;
  path: string;
  state: string;
  error: string | null;
  target_path: string | null;
};
function CoursePreviewFields({
  item,
  onPreview,
  onDirty,
  busy,
}: {
  item: RepairPreview;
  onPreview: (item: RepairPreview) => void;
  onDirty: () => void;
  busy: boolean;
}) {
  const [difficulty, setDifficulty] = useState(item.edits?.difficulty ?? ""),
    [importance, setImportance] = useState(item.edits?.importance ?? ""),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  async function preview() {
    setPending(true);
    setError("");
    try {
      const fields = new URLSearchParams();
      if (difficulty) fields.set("difficulty", difficulty);
      if (importance) fields.set("importance", importance);
      const response = await fetch(
        "/api/vault-health/course-preview/" +
          encodeURIComponent(item.issueId) +
          "?" +
          fields,
      );
      if (!response.ok) throw Error((await response.json()).message);
      onPreview((await response.json()) as RepairPreview);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update preview",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="view-controls">
      <label>
        Difficulty{" "}
        <select
          value={difficulty}
          disabled={pending || busy}
          onChange={(e) => {
            setDifficulty(e.target.value);
            onDirty();
          }}
        >
          <option value="">Omit</option>
          <option>beginner</option>
          <option>intermediate</option>
          <option>advanced</option>
        </select>
      </label>
      <label>
        Importance{" "}
        <select
          value={importance}
          disabled={pending || busy}
          onChange={(e) => {
            setImportance(e.target.value);
            onDirty();
          }}
        >
          <option value="">Omit</option>
          <option>low</option>
          <option>medium</option>
          <option>high</option>
        </select>
      </label>
      <button
        type="button"
        disabled={pending || busy}
        onClick={() => void preview()}
      >
        Update preview
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
function ChangeReview() {
  const [kind, setKind] = useState<
    "health-fix" | "python-course-migration" | "notes-migration"
  >("health-fix");
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [edited, setEdited] = useState<Record<string, RepairPreview>>({});
  const [selected, select] = useState<RepairPreview[]>([]),
    [confirmed, confirm] = useState(false);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const access = summary();
  const preview = query<RepairPreview[]>("vault-health/proposals?kind=" + kind);
  const history = query<RepairHistory[]>("changesets");
  async function mutate(path: string, body: object) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/" + path, {
        method: "POST",
        headers: { "X-Synapse": "1", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw Error((await response.json()).message);
      select([]);
      setEdited({});
      setDirty({});
      confirm(false);
      await client.invalidateQueries();
      setMessage("Change recorded. Review the result below.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The change could not be recorded.",
      );
    } finally {
      setBusy(false);
    }
  }
  function toggle(item: RepairPreview, checked: boolean) {
    confirm(false);
    select((previous) =>
      checked
        ? [...previous.filter((entry) => entry.path !== item.path), item]
        : previous.filter((entry) => entry.issueId !== item.issueId),
    );
  }
  const writable = access.data?.writeEnabled === true;
  return (
    <section
      className="change-review"
      aria-label="Vault repairs and migrations"
    >
      <h2>Proposed changes</h2>
      <div className="view-controls">
        <label>
          Workflow{" "}
          <select
            value={kind}
            onChange={(e) => {
              setKind(
                e.target.value === "python-course-migration"
                  ? "python-course-migration"
                  : e.target.value === "notes-migration"
                    ? "notes-migration"
                    : "health-fix",
              );
              select([]);
              confirm(false);
              setMessage("");
            }}
          >
            <option value="health-fix">Vault repairs</option>
            <option value="python-course-migration">
              Python Course metadata
            </option>
            <option value="notes-migration">Legacy note reorganization</option>
          </select>
        </label>
      </div>
      {preview.error && <p role="alert">{preview.error.message}</p>}
      {preview.data?.length === 0 && (
        <p>No proposals are available in this workflow.</p>
      )}
      {!writable && (
        <p>The vault is read-only. You can inspect each preview.</p>
      )}
      {preview.data
        ?.map((original) =>
          edited[original.issueId]?.baseHash === original.baseHash
            ? edited[original.issueId]!
            : original,
        )
        .map((item) => (
          <details className="change-item" key={item.issueId}>
            <summary>{item.path}</summary>
            <p>{item.evidence}</p>
            {kind === "python-course-migration" && (
              <CoursePreviewFields
                item={item}
                busy={busy}
                onDirty={() => {
                  setDirty((previous) => ({
                    ...previous,
                    [item.issueId]: true,
                  }));
                  toggle(item, false);
                }}
                onPreview={(next) => {
                  setDirty((previous) => ({
                    ...previous,
                    [next.issueId]: false,
                  }));
                  setEdited((previous) => ({
                    ...previous,
                    [next.issueId]: next,
                  }));
                  toggle(item, false);
                }}
              />
            )}
            {item.targetPath ? (
              <dl className="note-properties">
                <div>
                  <dt>Current path</dt>
                  <dd>{item.path}</dd>
                </div>
                <div>
                  <dt>Destination</dt>
                  <dd>{item.targetPath}</dd>
                </div>
              </dl>
            ) : (
              <div className="change-diff">
                <div>
                  <h3>Before</h3>
                  <pre>{item.before}</pre>
                </div>
                <div>
                  <h3>After</h3>
                  <pre>{item.after}</pre>
                </div>
              </div>
            )}
            <label className="change-approval">
              <input
                type="checkbox"
                disabled={!writable || busy || !!dirty[item.issueId]}
                checked={selected.some(
                  (entry) =>
                    entry.issueId === item.issueId &&
                    entry.baseHash === item.baseHash &&
                    entry.afterHash === item.afterHash,
                )}
                onChange={(e) => toggle(item, e.target.checked)}
              />{" "}
              Approve this file
            </label>
          </details>
        ))}
      {!!selected.length && (
        <ul>
          {selected.map((item) => (
            <li key={item.path}>{item.path}</li>
          ))}
        </ul>
      )}
      {selected.length > 0 && (
        <div className="view-controls">
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => confirm(e.target.checked)}
            />{" "}
            Confirm changes to {selected.length}{" "}
            {selected.length === 1 ? "file" : "files"}
          </label>
          <button
            type="button"
            disabled={busy || !confirmed || !writable}
            onClick={() =>
              void mutate("changesets/apply", {
                kind,
                confirm: true,
                items: selected.map(
                  ({ issueId, baseHash, afterHash, edits }) => ({
                    issueId,
                    baseHash,
                    afterHash,
                    edits,
                  }),
                ),
              })
            }
          >
            Apply approved changes
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {!!history.data?.length && (
        <>
          <h2>Change history</h2>
          <ul className="issues">
            {history.data.map((item) => (
              <li key={item.id}>
                <strong>{item.state}</strong>
                <small>
                  {item.path}
                  {item.target_path && " → " + item.target_path}
                </small>
                {item.error && <p>{item.error}</p>}
                {item.state === "applied" && writable && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          "Restore the previous bytes of " + item.path + "?",
                        )
                      )
                        void mutate("changesets/items/" + item.id + "/revert", {
                          confirm: true,
                        });
                    }}
                  >
                    Undo this change
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
function Health() {
  const result = query<Issue[]>("vault-health/issues");
  return (
    <>
      <h1>Vault Health</h1>
      <ChangeReview />
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
      component: Dashboard,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/roadmap/tree",
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
      path: "/resources",
      component: ResourcesPage,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/notes",
      component: PersonalNotesPage,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/notes/$slug",
      component: PersonalNotePage,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/health",
      component: Health,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/sessions",
      component: StudyHistory,
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
