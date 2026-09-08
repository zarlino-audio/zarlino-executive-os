/** Executive OS console shell — lazy-loaded views, command palette, keyboard
 * nav, boot splash, live ticker, and a single throttled data fetch (polls
 * pause while the tab is hidden to save API + CPU). */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { api, clearToken, getToken, setToken, type DataBundle } from "./api";
import { BootSplash, CommandPalette, Confetti, Ticker, usePolling } from "./lib/entertain";

// ---- Lazy views (code-split per module for fast initial load) --------------

const Overview = lazy(() => import("./views/core").then((m) => ({ default: m.Overview })));
const Activity = lazy(() => import("./views/core").then((m) => ({ default: m.Activity })));
const Tasks = lazy(() => import("./views/core").then((m) => ({ default: m.Tasks })));
const Approvals = lazy(() => import("./views/core").then((m) => ({ default: m.Approvals })));
const Reviews = lazy(() => import("./views/reviews").then((m) => ({ default: m.ReviewsView })));
const Perceptual = lazy(() => import("./views/perceptual").then((m) => ({ default: m.PerceptualView })));
const Pipeline = lazy(() => import("./views/business").then((m) => ({ default: m.Pipeline })));
const Finance = lazy(() => import("./views/business").then((m) => ({ default: m.Finance })));
const Decisions = lazy(() => import("./views/business").then((m) => ({ default: m.Decisions })));
const Catalog = lazy(() => import("./views/business").then((m) => ({ default: m.Catalog })));
const Doctrine = lazy(() => import("./views/knowledge").then((m) => ({ default: m.Doctrine })));
const MemoryView = lazy(() => import("./views/knowledge").then((m) => ({ default: m.MemoryView })));
const CalendarView = lazy(() => import("./views/knowledge").then((m) => ({ default: m.CalendarView })));
const NotesView = lazy(() => import("./views/knowledge").then((m) => ({ default: m.NotesView })));
const FilesView = lazy(() => import("./views/ops").then((m) => ({ default: m.FilesView })));
const LocalRunsView = lazy(() => import("./views/ops").then((m) => ({ default: m.LocalRunsView })));
const DoctorView = lazy(() => import("./views/ops").then((m) => ({ default: m.DoctorView })));
const ProductivityView = lazy(() => import("./views/ops").then((m) => ({ default: m.ProductivityView })));
const ChatView = lazy(() => import("./views/chat").then((m) => ({ default: m.ChatView })));
const SettingsView = lazy(() => import("./views/settings").then((m) => ({ default: m.SettingsView })));

interface ViewProps {
  data: DataBundle;
  mutate: () => Promise<void>;
  notify: (msg: string, ok?: boolean) => void;
}

interface ViewDef {
  id: string;
  label: string;
  group: string;
  emoji: string;
  comp: React.LazyExoticComponent<(p: ViewProps) => React.ReactElement | null>;
}

const VIEWS: ViewDef[] = [
  { id: "overview", label: "Overview", group: "Operate", emoji: "🏠", comp: Overview },
  { id: "activity", label: "Activity", group: "Operate", emoji: "🕘", comp: Activity },
  { id: "tasks", label: "Tasks", group: "Operate", emoji: "✅", comp: Tasks },
  { id: "approvals", label: "Approvals", group: "Operate", emoji: "✋", comp: Approvals },
  { id: "reviews", label: "Reviews", group: "Operate", emoji: "🎧", comp: Reviews },
  { id: "perceptual", label: "Perceptual", group: "Operate", emoji: "👂", comp: Perceptual },
  { id: "pipeline", label: "Pipeline", group: "Operate", emoji: "🚀", comp: Pipeline },
  { id: "finance", label: "Finance", group: "Operate", emoji: "💰", comp: Finance },
  { id: "decisions", label: "Decisions & Risks", group: "Knowledge", emoji: "🧭", comp: Decisions },
  { id: "doctrine", label: "Doctrine", group: "Knowledge", emoji: "📜", comp: Doctrine },
  { id: "memory", label: "Memory", group: "Knowledge", emoji: "🧠", comp: MemoryView },
  { id: "calendar", label: "Calendar", group: "Knowledge", emoji: "📅", comp: CalendarView },
  { id: "notes", label: "Notes & Contacts", group: "Knowledge", emoji: "📝", comp: NotesView },
  { id: "catalog", label: "Catalog", group: "Knowledge", emoji: "🗂️", comp: Catalog },
  { id: "doctor", label: "System Doctor", group: "System", emoji: "🩺", comp: DoctorView },
  { id: "productivity", label: "Productivity", group: "System", emoji: "⚡", comp: ProductivityView },
  { id: "files", label: "Files", group: "System", emoji: "📁", comp: FilesView },
  { id: "local", label: "Local & Runs", group: "System", emoji: "🖥️", comp: LocalRunsView },
  { id: "chat", label: "Chat", group: "System", emoji: "💬", comp: ChatView },
  { id: "settings", label: "Settings", group: "Account", emoji: "⚙️", comp: SettingsView },
];

const VIEW_MAP = new Map(VIEWS.map((v) => [v.id, v]));

/** Safe empty bundle so views render before the first fetch completes. */
const EMPTY_BUNDLE: DataBundle = {
  generatedAt: "",
  state: { status: "GREEN", autonomy_mode: "CONTROLLED", paused: 0, spending_disabled: 0, deployments_disabled: 0, delegate_mode: 0, full_access: 0 },
  counters: {},
  products: [],
  productStatus: [],
  projects: [],
  objectives: [],
  tasks: [],
  decisions: [],
  risks: [],
  engineering: [],
  marketing: [],
  doctrine: [],
  policies: [],
  memories: [],
  pipeline: [],
  persons: [],
  finance: null,
  financialSnapshots: [],
  calendar: [],
  notes: [],
  reminders: [],
  contacts: [],
  audit: [],
  files: [],
  localTasks: [],
  runs: [],
  toolExecutions: [],
  metrics: [],
  workstreams: [],
  budget: { daily: 0, monthly: 0, spentToday: 0, spentThisMonth: 0, tokensToday: 0, tokensThisMonth: 0, overrides: {} },
  founderBrief: { overdueReminders: [], pendingApprovals: [], openContradictions: [], topRisks: [], pendingReviews: [], generatedAt: "" },
  reviews: [],
  perceptual: {
    tests: [],
    results: [],
    evaluators: [],
    knowledge: [],
    validations: [],
    failures: [],
    kpi: {
      validatedProductYield: null,
      seriousExperiments: 0,
      viableProducts: 0,
      testsByStatus: {},
      testsByTier: {},
      evaluatorsActive: 0,
      evidenceGaps: [],
      avgCycleDays: null,
    },
  },
  productivity: { assignments: [], optimizationEvents: [], contradictions: [], budgets: [] },
  doctorLastRun: null,
  localAgent: { host: null, seenAgoMs: null, online: false, pending: 0 },
  links: {},
};

export function App() {
  const [token, setTokenState] = useState(getToken());
  const [view, setView] = useState("overview");
  const [data, setData] = useState<DataBundle | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState<{ id: number; text: string; ok: boolean } | null>(null);
  const [palette, setPalette] = useState(false);
  const [booted, setBooted] = useState(() => sessionStorage.getItem("exec_os_booted") === "1");
  const [confetti, setConfetti] = useState(false);
  const confettiTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((text: string, ok = true) => {
    const id = Date.now();
    setToast({ id, text, ok });
    setTimeout(() => setToast((t) => (t && t.id === id ? null : t)), 4000);
  }, []);

  const load = useCallback(async () => {
    try {
      const d = await api.dataAll();
      setData(d);
      setError("");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, []);

  // Initial load + 60s poll (pauses when hidden — handled inside usePolling).
  useEffect(() => {
    void load();
  }, [load]);
  usePolling(() => void load(), 60_000, []);

  // Keyboard: Ctrl/Cmd+K opens palette, "?" opens palette (ignored while
  // typing), Alt+←/→ cycles views (guarded so it can't destroy draft text).
  useEffect(() => {
    const isEditable = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (isEditable(e.target)) return; // never hijack typing in inputs
      if (e.key === "?") {
        setPalette((p) => !p);
      } else if (e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        const i = VIEWS.findIndex((v) => v.id === view);
        setView(VIEWS[(i + 1) % VIEWS.length]!.id);
      } else if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        const i = VIEWS.findIndex((v) => v.id === view);
        setView(VIEWS[(i - 1 + VIEWS.length) % VIEWS.length]!.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);

  // Session expiry: a 401 anywhere clears the token and returns to the login
  // gate instead of leaving the founder stuck in a dead app.
  useEffect(() => {
    const onUnauthorized = () => {
      clearToken();
      setTokenState("");
      setView("overview");
    };
    window.addEventListener("exec-os-unauthorized", onUnauthorized);
    return () => window.removeEventListener("exec-os-unauthorized", onUnauthorized);
  }, []);

  const signOut = async () => {
    try {
      await api.logout();
    } catch { /* session may be gone */ }
    clearToken();
    setTokenState("");
    setView("overview");
  };

  const celebrate = () => {
    setConfetti(true);
    if (confettiTimer.current) clearTimeout(confettiTimer.current);
    confettiTimer.current = setTimeout(() => setConfetti(false), 3200);
  };

  if (!booted && token) {
    return (
      <BootSplash
        onDone={() => {
          sessionStorage.setItem("exec_os_booted", "1");
          setBooted(true);
          celebrate();
        }}
      />
    );
  }

  if (!token) {
    return <Login onLogin={(t) => { setToken(t); setTokenState(t); void load(); celebrate(); }} />;
  }

  const current = VIEW_MAP.get(view) ?? VIEWS[0]!;
  const props: ViewProps = { data: data ?? EMPTY_BUNDLE, mutate: async () => { await load(); }, notify };
  const C = current.comp;

  return (
    <div>
      {confetti && <Confetti />}
      <header>
        <div>
          <h1>Zarlino <span>Executive OS</span></h1>
          <Ticker />
        </div>
        <nav>
          {VIEWS.map((v) => (
            <button key={v.id} className={view === v.id ? "active" : ""} onClick={() => setView(v.id)} title={v.label}>
              {v.emoji}
              <span className="nav-label">{v.label}</span>
            </button>
          ))}
          <button className="ghost" onClick={() => void signOut()} title="Sign out (Ctrl+K to jump)">
            ⏻
          </button>
        </nav>
      </header>

      {error && !data && <div className="error-box">{error}</div>}
      {error && data && (
        <div className="error-box" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>⚠️ Showing stale data — refresh failed: {error}</span>
          <button className="mini" onClick={() => void load()}>Retry</button>
        </div>
      )}

      {toast && <div className={`toast ${toast.ok ? "ok" : "fail"}`} key={toast.id}>{toast.text}</div>}

      <Suspense
        fallback={
          <div className="loading">
            <span className="dot" /><span className="dot" /><span className="dot" /> loading {current.label}…
          </div>
        }
      >
        {data === null && !error ? (
          <div className="loading">
            <span className="dot" /><span className="dot" /><span className="dot" /> loading live data…
          </div>
        ) : (
          <C {...props} />
        )}
      </Suspense>

      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        onPick={(id) => setView(id)}
        items={VIEWS.map((v) => ({ id: v.id, label: `${v.emoji} ${v.label}`, hint: v.group }))}
      />

      <footer className="muted">
        <span>Ctrl/⌘+K jump · Alt+←/→ views · {VIEWS.length} views · data refreshes every 60s{data?.generatedAt ? ` · data as of ${new Date(data.generatedAt).toLocaleTimeString()}` : ""}</span>
      </footer>
    </div>
  );
}

// ---- Login ------------------------------------------------------------------

function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.login(username.trim(), password);
      onLogin(res.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <h1>Zarlino <span>Executive OS</span></h1>
        <p className="muted">Sign in with your Founder username and password. Sessions last 30 days.</p>
        {error && <div className="error-box">{error}</div>}
        <label>Username</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="Khritical" autoFocus autoComplete="username" />
        <label>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="••••" autoComplete="current-password" />
        <div className="row" style={{ marginTop: 14 }}>
          <button className="action" onClick={submit} disabled={busy || !username.trim() || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </div>
    </div>
  );
}
