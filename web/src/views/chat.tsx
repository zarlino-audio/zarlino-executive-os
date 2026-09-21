/**
 * Executive chat — a three-panel founder console built to Claude standards:
 *   left   sessions sidebar : New chat, search, conversation history grouped by
 *                             date (Pinned / Today / Yesterday / This week /
 *                             Earlier), rename, pin, delete, pagination.
 *   center main thread      : token-by-token streaming with a live caret,
 *                             reasoning panel, tool-status narration, markdown
 *                             (tables/lists/quotes/links/highlighted code),
 *                             regenerate, edit-and-resend, thumbs feedback,
 *                             attachments, export, search, day separators,
 *                             grouping, jump-to-latest, a11y + mobile polish.
 *   right  context rail     : live decisions, pending approvals, contradictions,
 *                             and local daemon status surfaced from the bundle —
 *                             tap any item to ask about it.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  chatSse,
  type ChatAttachment,
  type ChatMessage,
  type ChatSession,
  type ChatStreamFrame,
  type Contradiction,
  type DataBundle,
} from "../api";
import { Markdown, timeAgo } from "../lib/entertain";

interface ViewProps {
  data: DataBundle;
  mutate: () => Promise<void>;
  notify: (msg: string, ok?: boolean) => void;
}

const SUGGESTIONS = [
  "Give me the daily brief",
  "What's blocking the ZTame P8 release?",
  "Summarize open contradictions",
  "What did the daemon work on today?",
];

const QUICK_PROMPTS = [
  "Daily brief",
  "Pipeline status",
  "Open approvals",
  "Productivity report",
  "System health",
];

const MODELS = [
  { id: "deepseek-chat", label: "V4 Flash", hint: "Fast everyday agent (tools on)" },
  { id: "deepseek-reasoner", label: "V4 Pro", hint: "Deeper reasoning (slower)" },
] as const;

const PIN_KEY = "exec_os_chat_pins";
const MODEL_KEY = "exec_os_chat_model";
/** Composer guard: 8k chars keeps prompts (and the model bill) sane. */
const MAX_INPUT = 8000;
const MAX_ATTACH_BYTES = 8 * 1024 * 1024;

/**
 * A rendered message. `id` is the server id once persisted; assistant rows can
 * additionally carry live streaming state (reasoning, tool status, stop flag).
 */
type Msg = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
  rating?: number | null;
  model?: string | null;
  attachments?: ChatAttachment[];
  reasoning?: string;
  status?: string;
  cancelled?: boolean;
  error?: string;
};

const ATTACHMENT_RE = /\n*\[attachments\]\s*(.+?)(?:\n|$)/;

/** Split the stored attachment manifest out of a message for display. */
function splitAttachments(content: string): { text: string; attachments: ChatAttachment[] } {
  const m = ATTACHMENT_RE.exec(content);
  if (!m) return { text: content, attachments: [] };
  const attachments: ChatAttachment[] = [];
  for (const part of (m[1] ?? "").split(",")) {
    const idMatch = /id=([\w-]+)/.exec(part);
    if (!idMatch) continue;
    const name = part.replace(/\s*\(.*$/, "").trim() || "file";
    attachments.push({ id: idMatch[1]!, name });
  }
  return { text: content.replace(ATTACHMENT_RE, "").trimEnd(), attachments };
}

function sessionTitle(s: ChatSession): string {
  if (s.title && s.title.trim()) return s.title.trim();
  const raw = (s.last_message || s.session_id).replace(/\r?\n+/g, " ").trim();
  if (raw === s.session_id || raw === "") return "New conversation";
  return raw.length > 56 ? `${raw.slice(0, 56)}...` : raw;
}

function dateGroup(lastAt: string): string {
  if (!lastAt) return "Earlier";
  const t = Date.parse(lastAt);
  if (Number.isNaN(t)) return "Earlier";
  const now = new Date();
  const d = new Date(t);
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startYesterday = startToday - 24 * 3600 * 1000;
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (dayStart >= startToday) return "Today";
  if (dayStart >= startYesterday) return "Yesterday";
  if (dayStart >= startToday - 7 * 24 * 3600 * 1000) return "This week";
  return "Earlier";
}

/** "Today" / "Yesterday" / "12 Mar 2026" for the transcript day separators. */
function dayLabel(iso?: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const now = new Date();
  const same = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, now)) return "Today";
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
  if (same(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function clockOf(iso?: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

const GROUP_ORDER = ["Today", "Yesterday", "This week", "Earlier"];
const PAGE_SIZE = 60;

export function ChatView({ data, mutate: _mutate, notify }: ViewProps) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionId, setSessionId] = useState<string>(() => localStorage.getItem("exec_os_chat_session") ?? "default");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [loadingSessionsMore, setLoadingSessionsMore] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [sessionQuery, setSessionQuery] = useState("");
  const [msgQuery, setMsgQuery] = useState("");
  const [showMsgSearch, setShowMsgSearch] = useState(false);
  const [model, setModel] = useState<string>(() => localStorage.getItem(MODEL_KEY) ?? MODELS[0].id);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [copiedKey, setCopiedKey] = useState("");
  const [editingId, setEditingId] = useState("");
  const [editText, setEditText] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  const [pins, setPins] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(PIN_KEY) ?? "[]") as string[]);
    } catch {
      return new Set<string>();
    }
  });
  const [rail, setRail] = useState<"decisions" | "approvals" | "contradictions" | "daemon">(
    () => (localStorage.getItem("exec_os_chat_rail") as "decisions" | "approvals" | "contradictions" | "daemon") || "decisions",
  );
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamIdRef = useRef<string>("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sessionIdRef = useRef(sessionId);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { localStorage.setItem("exec_os_chat_rail", rail); }, [rail]);
  useEffect(() => { localStorage.setItem(PIN_KEY, JSON.stringify(Array.from(pins))); }, [pins]);
  useEffect(() => { localStorage.setItem(MODEL_KEY, model); }, [model]);

  const loadSessions = useCallback(async (offset = 0, append = false) => {
    try {
      const r = await api.chatSessions({ limit: 40, offset });
      setSessions((prev) => (append ? [...prev, ...r.sessions] : r.sessions));
      setHasMoreSessions(r.hasMore);
      setSessionTotal(r.total ?? r.sessions.length);
    } catch {
      /* non-fatal */
    }
  }, []);

  const loadHistory = useCallback(async (sid: string) => {
    try {
      const r = await api.chatMessages(sid, { limit: PAGE_SIZE });
      setMessages(
        r.messages.map((m: ChatMessage) => {
          const split = splitAttachments(m.content);
          return {
            id: m.id,
            role: m.role,
            content: split.text,
            created_at: m.created_at,
            rating: m.rating ?? null,
            model: m.model ?? null,
            attachments: split.attachments.length ? split.attachments : undefined,
          };
        }),
      );
      setHasEarlier(r.hasMore);
    } catch {
      setMessages([]);
      setHasEarlier(false);
    } finally {
      setHistoryLoaded(true);
    }
  }, []);

  /** Pull the previous page (gap 14/23 — no more silent 200-message wall). */
  const loadEarlier = useCallback(async () => {
    const sid = sessionIdRef.current;
    const earliest = messages.find((m) => m.created_at)?.created_at;
    if (!earliest || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const r = await api.chatMessages(sid, { limit: PAGE_SIZE, before: earliest });
      setMessages((prev) => {
        const older: Msg[] = r.messages.map((m: ChatMessage) => {
          const split = splitAttachments(m.content);
          return {
            id: m.id,
            role: m.role,
            content: split.text,
            created_at: m.created_at,
            rating: m.rating ?? null,
            model: m.model ?? null,
            attachments: split.attachments.length ? split.attachments : undefined,
          };
        });
        return [...older, ...prev];
      });
      setHasEarlier(r.hasMore);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), false);
    } finally {
      setLoadingEarlier(false);
    }
  }, [messages, loadingEarlier, notify]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    localStorage.setItem("exec_os_chat_session", sessionId);
    setHistoryLoaded(false);
    setMsgQuery("");
    setShowMsgSearch(false);
    setEditingId("");
    setEditingTitle(false);
    setAttachments([]);
    void loadHistory(sessionId);
  }, [sessionId, loadHistory]);

  useEffect(() => {
    if (busy) {
      const t = setInterval(() => setElapsed((e) => e + 1), 1000);
      return () => clearInterval(t);
    }
    setElapsed(0);
    return undefined;
  }, [busy]);

  // Track whether the founder is reading the bottom; auto-scroll only then.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const onScroll = () => {
      setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 140);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [historyLoaded]);

  useEffect(() => {
    const el = logRef.current;
    if (!el || !atBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming, atBottom]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(""), 8000);
    return () => clearTimeout(t);
  }, [error]);

  // Keyboard affordances (gap 15): Esc stops a running reply, "/" focuses the
  // composer from anywhere (unless the founder is already typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable);
      if (e.key === "Escape" && busy) {
        e.preventDefault();
        stop();
        return;
      }
      if (e.key === "/" && !typing) {
        e.preventDefault();
        composerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  const jumpToLatest = useCallback(() => {
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  /**
   * Consume one streamed turn: the provider's deltas arrive as frames and are
   * appended live (text / reasoning / tool status), then the transcript is
   * reconciled from the server so ids, ratings and the saved partial match.
   */
  const streamTurn = async (sid: string, startStream: () => Promise<{ streamId: string }>) => {
    setBusy(true);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { streamId } = await startStream();
      streamIdRef.current = streamId;
      setMessages((m) => [...m, { role: "assistant", content: "" }]);
      await chatSse(streamId, {
        signal: controller.signal,
        onFrame: (frame: ChatStreamFrame) => {
          if (sessionIdRef.current !== sid) return;
          setMessages((m) => {
            const next = [...m];
            const idx = next.length - 1;
            const last = next[idx];
            if (!last || last.role !== "assistant") return m;
            const updated: Msg = { ...last };
            if (frame.text) updated.content = `${updated.content}${frame.text}`;
            if (frame.reasoning) updated.reasoning = `${updated.reasoning ?? ""}${frame.reasoning}`;
            if (frame.status) updated.status = frame.status;
            if (frame.cancelled) updated.cancelled = true;
            if (frame.error) updated.error = frame.error;
            next[idx] = updated;
            return next;
          });
        },
      });
    } catch (e) {
      const isAbort = e instanceof DOMException && e.name === "AbortError";
      if (!isAbort) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        notify(`Chat failed: ${msg}`, false);
      }
    } finally {
      // Reconcile with the server: persisted ids/order/rating + saved partial.
      await loadHistory(sid).catch(() => {});
      await loadSessions();
      setBusy(false);
      setStreaming(false);
      abortRef.current = null;
      streamIdRef.current = "";
    }
  };

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || busy) return;
    const sid = sessionIdRef.current; // capture — the founder may switch sessions mid-stream
    const outgoing = attachments.slice();
    setInput("");
    setAttachments([]);
    setError("");
    setMessages((m) => [...m, { role: "user", content, attachments: outgoing.length ? outgoing : undefined }]);
    await streamTurn(sid, () =>
      api.chatStreamStart(content, sid, { model, attachments: outgoing.map((a) => ({ id: a.id, name: a.name, kind: a.kind })) }),
    );
  };

  const stop = () => {
    const streamId = streamIdRef.current;
    // Cancel the provider call server-side too — stopping must stop the work,
    // not just hide it (gap 6).
    if (streamId) void api.chatStop(streamId).catch(() => {});
    abortRef.current?.abort();
    setBusy(false);
    setStreaming(false);
  };

  const regenerate = async () => {
    const sid = sessionIdRef.current;
    if (busy) return;
    setError("");
    setMessages((m) => {
      const next = [...m];
      while (next.length > 0 && next[next.length - 1]!.role === "assistant") next.pop();
      return next;
    });
    await streamTurn(sid, async () => ({ streamId: (await api.chatRegenerate(sid, model)).streamId }));
  };

  const startEdit = (m: Msg) => {
    if (!m.id || busy) return;
    setEditingId(m.id);
    setEditText(m.content);
  };

  /** Edit a founder turn: truncate it (and everything after) then resend (gap 5). */
  const saveEdit = async () => {
    const id = editingId;
    const sid = sessionIdRef.current;
    const text = editText.trim();
    setEditingId("");
    setEditText("");
    if (!id || !text || busy) return;
    try {
      await api.chatTruncate(sid, id);
      setMessages((m) => {
        const idx = m.findIndex((x) => x.id === id);
        const head = idx >= 0 ? m.slice(0, idx) : m;
        return [...head, { role: "user", content: text }];
      });
      await streamTurn(sid, () => api.chatStreamStart(text, sid, { model }));
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), false);
    }
  };

  const rate = async (m: Msg, value: number) => {
    if (!m.id) return;
    const next = m.rating === value ? 0 : value;
    setMessages((all) => all.map((x) => (x.id === m.id ? { ...x, rating: next } : x)));
    try {
      await api.chatRate(m.id, next);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), false);
    }
  };

  const newChat = async () => {
    const sid = `chat_${Date.now().toString(36)}`;
    localStorage.setItem("exec_os_chat_session", sid);
    setSessionId(sid);
    setMessages([]);
    setHistoryLoaded(true);
    setHasEarlier(false);
    await loadSessions();
  };

  const deleteSession = async (sid: string) => {
    if (!window.confirm("Delete this conversation? This cannot be undone.")) return;
    try {
      await api.clearChat(sid);
      const nextPins = new Set(pins);
      nextPins.delete(sid);
      setPins(nextPins);
      if (sid === sessionId) {
        await newChat();
      } else {
        await loadSessions();
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), false);
    }
  };

  const togglePin = (sid: string) => {
    setPins((prev) => {
      const next = new Set(prev);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });
  };

  const saveTitle = async () => {
    const sid = sessionIdRef.current;
    const title = titleDraft.trim();
    setEditingTitle(false);
    if (!title) return;
    try {
      await api.chatRename(sid, title);
      await loadSessions();
      notify("Renamed");
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), false);
    }
  };

  const copy = async (text: string, key?: string) => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      if (key) {
        setCopiedKey(key);
        setTimeout(() => setCopiedKey(""), 1600);
      }
      notify("Copied");
    } catch {
      notify("Could not copy to clipboard", false);
    }
  };

  const convoText = () =>
    messages
      .filter((m) => m.content.trim().length > 0)
      .map((m) => `## ${m.role === "user" ? "Founder" : "Zarlino"}\n\n${m.content}`)
      .join("\n\n");

  /** Export / copy the whole thread (gap 17). */
  const exportConversation = (fmt: "md" | "json") => {
    const sid = sessionIdRef.current;
    const blob =
      fmt === "md"
        ? new Blob([`# ${currentSession ? sessionTitle(currentSession) : sid}\n\n${convoText()}\n`], { type: "text/markdown;charset=utf-8" })
        : new Blob(
            [
              JSON.stringify(
                messages.map(({ role, content, created_at, model: mdl, rating }) => ({ role, content, created_at, model: mdl, rating })),
                null,
                2,
              ),
            ],
            { type: "application/json;charset=utf-8" },
          );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sid}.${fmt}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const fileToBase64 = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? "");
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : "");
      };
      reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
      reader.readAsDataURL(file);
    });

  /** Upload attachments via /api/files; the turn carries their ids (gap 11). */
  const addFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    const list = Array.from(files).slice(0, 6);
    if (list.length === 0) return;
    setUploading(true);
    try {
      for (const f of list) {
        if (f.size > MAX_ATTACH_BYTES) {
          notify(`${f.name} is larger than 8 MB`, false);
          continue;
        }
        const b64 = await fileToBase64(f);
        const r = await api.uploadFile(f.name, f.type || "application/octet-stream", b64);
        setAttachments((a) => [...a, { id: r.fileId, name: f.name, kind: r.kind, sizeBytes: r.sizeBytes }]);
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), false);
    } finally {
      setUploading(false);
    }
  };

  const removeAttachment = (id: string) => setAttachments((a) => a.filter((x) => x.id !== id));

  // ---- context rail data (surfaced from the bundle) ------------------------

  const decisions = (data.decisions ?? []).slice(0, 6);
  const contradictions: Contradiction[] = data.productivity?.contradictions ?? [];
  const openContradictions = contradictions.filter((c) => c.status !== "resolved");
  const pendingApprovals = (data.founderBrief?.pendingApprovals ?? []).slice(0, 6);
  const localAgent = data.localAgent;

  // ---- session sidebar (grouped + pinned + searchable) ---------------------

  const filteredSessions = useMemo(() => {
    const q = sessionQuery.trim().toLowerCase();
    const list = q
      ? sessions.filter(
          (s) =>
            sessionTitle(s).toLowerCase().includes(q) ||
            (s.last_message || "").toLowerCase().includes(q) ||
            s.session_id.toLowerCase().includes(q),
        )
      : sessions;
    return [...list].sort((a, b) => (b.last_at || "").localeCompare(a.last_at || ""));
  }, [sessions, sessionQuery]);

  const pinnedSessions = filteredSessions.filter((s) => pins.has(s.session_id));
  const mainSessions = filteredSessions.filter((s) => !pins.has(s.session_id));
  const grouped = useMemo(() => {
    const map: Record<string, ChatSession[]> = {};
    for (const g of GROUP_ORDER) map[g] = [];
    for (const s of mainSessions) {
      const g = dateGroup(s.last_at);
      if (!map[g]) map[g] = [];
      map[g]!.push(s);
    }
    return GROUP_ORDER.map((g) => ({ group: g, items: map[g]! })).filter((x) => x.items.length > 0);
  }, [mainSessions]);

  // ---- message search (filter within active thread) ------------------------

  const filteredMessages = useMemo(() => {
    const q = msgQuery.trim().toLowerCase();
    if (!q) return messages;
    return messages.filter((m) => m.content.toLowerCase().includes(q));
  }, [messages, msgQuery]);

  // Windowing (gap 13): only the newest slice is mounted unless the founder
  // explicitly asks for the whole thread; server pagination extends the tail.
  const [showAllMessages, setShowAllMessages] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const WINDOW_SIZE = 120;
  const hiddenCount = !showAllMessages && !msgQuery.trim() ? Math.max(0, filteredMessages.length - WINDOW_SIZE) : 0;
  const displayMessages = hiddenCount > 0 ? filteredMessages.slice(-WINDOW_SIZE) : filteredMessages;

  /**
   * Rows = day separators + messages with grouping flags, so the stylesheet's
   * `.day-sep` / `.first-in-group` classes are actually used (gaps 9, 25).
   */
  const rows = useMemo(() => {
    const out: Array<{ kind: "day"; key: string; label: string } | { kind: "msg"; key: string; m: Msg; index: number; first: boolean }> = [];
    let lastDay = "";
    let lastRole = "";
    displayMessages.forEach((m, index) => {
      const label = dayLabel(m.created_at);
      if (label && label !== lastDay) {
        out.push({ kind: "day", key: `day-${label}-${index}`, label });
        lastDay = label;
        lastRole = "";
      }
      const first = m.role !== lastRole;
      out.push({ kind: "msg", key: m.id ?? `m-${index}`, m, index, first });
      lastRole = m.role;
    });
    // The live streaming bubble is not persisted yet — show it as its own row.
    if (streaming) {
      out.push({ kind: "msg", key: "streaming", m: messages[messages.length - 1] ?? { role: "assistant", content: "" }, index: messages.length - 1, first: lastRole !== "assistant" });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayMessages, streaming, messages.length]);

  const currentSession = sessions.find((s) => s.session_id === sessionId);
  const currentTitle = currentSession ? sessionTitle(currentSession) : "New conversation";
  const lastAssistantIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "assistant" && !busy) return i;
    }
    return -1;
  })();

  // ---- render --------------------------------------------------------------

  return (
    <div className="chat3">
      {/* ---------- sessions sidebar ---------- */}
      <aside className="chat3-side" aria-label="Conversations">
        <div className="chat3-side-head">
          <button className="action" style={{ width: "100%" }} onClick={() => void newChat()}>
            + New chat
          </button>
          <input
            value={sessionQuery}
            onChange={(e) => setSessionQuery(e.target.value)}
            placeholder="Search conversations…"
            aria-label="Search conversations"
            style={{ marginTop: 10 }}
          />
          {sessionQuery.trim() !== "" && (
            <button className="mini" style={{ width: "100%", marginTop: 6 }} onClick={() => setSessionQuery("")}>
              Clear search
            </button>
          )}
        </div>

        <div role="listbox" aria-label="Conversation history">
          {pinnedSessions.length > 0 && (
            <Section label="Pinned">
              {pinnedSessions.map((s) => (
                <SessionRow
                  key={s.session_id}
                  s={s}
                  active={s.session_id === sessionId}
                  onOpen={() => setSessionId(s.session_id)}
                  onDelete={() => void deleteSession(s.session_id)}
                  onPin={() => togglePin(s.session_id)}
                  onRename={() => { setSessionId(s.session_id); setTitleDraft(sessionTitle(s)); setEditingTitle(true); }}
                  pinned
                />
              ))}
            </Section>
          )}

          {pinnedSessions.length > 0 && mainSessions.length > 0 && <div className="chat3-sep" />}

          {grouped.map(({ group, items }) => (
            <Section key={group} label={group}>
              {items.map((s) => (
                <SessionRow
                  key={s.session_id}
                  s={s}
                  active={s.session_id === sessionId}
                  onOpen={() => setSessionId(s.session_id)}
                  onDelete={() => void deleteSession(s.session_id)}
                  onPin={() => togglePin(s.session_id)}
                  onRename={() => { setSessionId(s.session_id); setTitleDraft(sessionTitle(s)); setEditingTitle(true); }}
                  pinned={false}
                />
              ))}
            </Section>
          ))}
        </div>

        {!historyLoaded || (filteredSessions.length === 0 && pinnedSessions.length === 0) ? (
          <div className="muted" style={{ padding: "10px 6px", fontSize: 12 }}>
            {filteredSessions.length === 0 && sessions.length > 0 ? "No conversations match." : "Loading conversations…"}
          </div>
        ) : null}

        {hasMoreSessions && !sessionQuery.trim() && (
          <button
            className="mini"
            style={{ width: "100%", marginTop: 6 }}
            disabled={loadingSessionsMore}
            onClick={() => {
              setLoadingSessionsMore(true);
              void loadSessions(sessions.length, true).finally(() => setLoadingSessionsMore(false));
            }}
          >
            {loadingSessionsMore ? "loading…" : `Show more (${Math.max(0, sessionTotal - sessions.length)} older)`}
          </button>
        )}
      </aside>

      {/* ---------- main thread ---------- */}
      <section className="chat3-main" aria-label="Conversation">
        <div className="chat3-main-head">
          <div className="chat3-head-left">
            {editingTitle ? (
              <input
                className="chat3-title-input"
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => void saveTitle()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveTitle();
                  if (e.key === "Escape") setEditingTitle(false);
                }}
                aria-label="Conversation title"
              />
            ) : (
              <div className="chat3-title">
                <span className="chat3-title-text" title={currentTitle}>{currentTitle}</span>
                <button className="mini" title="Rename conversation" aria-label="Rename conversation" onClick={() => { setTitleDraft(currentTitle); setEditingTitle(true); }}>rename</button>
                <button className="mini" title={pins.has(sessionId) ? "Unpin" : "Pin this conversation"} aria-label={pins.has(sessionId) ? "Unpin conversation" : "Pin conversation"} onClick={() => togglePin(sessionId)}>
                  {pins.has(sessionId) ? "pinned" : "pin"}
                </button>
              </div>
            )}
            <div className="muted chat3-subtitle">
              {currentSession ? `${currentSession.message_count} messages • last ${timeAgo(currentSession.last_at)}` : "Start a conversation below — or pick one from the sidebar."}
            </div>
          </div>
          <div className="row chat3-head-tools">
            <select className="model-pick" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model" title="Model">
              {MODELS.map((mo) => (
                <option key={mo.id} value={mo.id} title={mo.hint}>{mo.label}</option>
              ))}
            </select>
            <button className="mini" title="Filter messages in this thread" aria-label="Search in this conversation" aria-pressed={showMsgSearch} onClick={() => { setShowMsgSearch((s) => !s); if (showMsgSearch) setMsgQuery(""); }}>
              {showMsgSearch ? "hide" : "search"}
            </button>
            <div className="menu-wrap">
              <button className="mini" title="Export conversation" aria-label="Export conversation" aria-haspopup="menu" aria-expanded={showExport} onClick={() => setShowExport((v) => !v)}>export</button>
              {showExport && (
                <div className="menu-pop" role="menu">
                  <button role="menuitem" onClick={() => { setShowExport(false); void copy(convoText(), "all"); }}>Copy whole thread</button>
                  <button role="menuitem" onClick={() => { setShowExport(false); exportConversation("md"); }}>Download .md</button>
                  <button role="menuitem" onClick={() => { setShowExport(false); exportConversation("json"); }}>Download .json</button>
                </div>
              )}
            </div>
            <button className="mini" title="New chat" aria-label="New chat" onClick={() => void newChat()}>+</button>
          </div>
        </div>

        {showMsgSearch && (
          <div style={{ padding: "8px 12px 0" }}>
            <input
              autoFocus
              value={msgQuery}
              onChange={(e) => setMsgQuery(e.target.value)}
              placeholder={`Search ${messages.length} messages…`}
              aria-label="Search messages"
            />
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              {msgQuery ? `${filteredMessages.length} of ${messages.length} messages match` : "Type to filter this thread"}
            </div>
          </div>
        )}

        <div
          className={`chat3-log ${dragOver ? "dragging" : ""}`}
          ref={logRef}
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
          aria-label="Conversation transcript"
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); void addFiles(e.dataTransfer?.files ?? null); }}
        >
          {dragOver && <div className="drop-overlay">Drop files to attach</div>}
          {error && <div className="error-box" role="alert">{error}</div>}
          {!historyLoaded && (
            <div className="loading">
              <span className="dot" /><span className="dot" /><span className="dot" /> loading…
            </div>
          )}
          {historyLoaded && filteredMessages.length === 0 && !streaming && (
            <div className="chat-hero">
              <h3 style={{ margin: "0 0 6px" }}>Zarlino Executive</h3>
              <p className="muted" style={{ margin: 0 }}>
                Ask about your pipeline, approvals, doctrine, or anything the daemon is working on. Attach a log or a screenshot, or start from a quick prompt below.
              </p>
              <div className="suggestion-row">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="suggestion" disabled={busy} onClick={() => void send(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {(hasEarlier || hiddenCount > 0) && !msgQuery.trim() && (
            <div className="load-earlier">
              <button
                className="mini"
                disabled={loadingEarlier}
                onClick={() => { if (hiddenCount > 0) setShowAllMessages(true); else void loadEarlier(); }}
              >
                {loadingEarlier ? "loading…" : hiddenCount > 0 ? `Show ${hiddenCount} earlier messages` : "Load earlier messages"}
              </button>
            </div>
          )}
          {rows.map((row) =>
            row.kind === "day" ? (
              <div className="day-sep" key={row.key} role="separator" aria-label={row.label}>
                <span>{row.label}</span>
              </div>
            ) : (
              <MessageRow
                key={row.key}
                m={row.m}
                first={row.first}
                live={streaming && row.index === messages.length - 1 && row.m.role === "assistant"}
                canRegenerate={lastAssistantIndex >= 0 && row.index === lastAssistantIndex}
                editing={!!row.m.id && row.m.id === editingId}
                editText={editText}
                onEditText={setEditText}
                onStartEdit={() => startEdit(row.m)}
                onSaveEdit={() => void saveEdit()}
                onCancelEdit={() => { setEditingId(""); setEditText(""); }}
                onCopy={(t) => void copy(t, row.key)}
                copied={copiedKey === row.key}
                onRegenerate={() => void regenerate()}
                onRate={(v) => void rate(row.m, v)}
              />
            ),
          )}
          {streaming && (
            <div className="stream-foot" aria-live="polite">
              <span className="stream-dots" aria-hidden="true"><i /><i /><i /></span>
              <span className="muted">{liveStatus(messages) ? `${liveStatus(messages)} · ` : ""}{elapsed}s</span>
              <button className="mini" onClick={stop}>stop</button>
            </div>
          )}
        </div>

        {!atBottom && (
          <button className="jump-latest" onClick={jumpToLatest} aria-label="Jump to the latest message">
            ↓ Latest
          </button>
        )}

        <div className="quick-row" style={{ padding: "2px 12px 0" }}>
          {QUICK_PROMPTS.map((q) => (
            <button key={q} className="quick-chip" disabled={busy} onClick={() => void send(q)}>{q}</button>
          ))}
        </div>

        <div className="chat3-composer">
          {attachments.length > 0 && (
            <div className="attach-row">
              {attachments.map((a) => (
                <span className="chip attach-chip" key={a.id}>
                  <span className="attach-name" title={a.name}>{a.name}</span>
                  <button className="mini" aria-label={`Remove attachment ${a.name}`} onClick={() => removeAttachment(a.id)}>x</button>
                </span>
              ))}
            </div>
          )}
          <div className="composer-row">
            <button
              className="mini attach-btn"
              title="Attach files (or drop them here / paste an image)"
              aria-label="Attach files"
              disabled={busy || uploading}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? "..." : "attach"}
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }}
            />
            <textarea
              ref={composerRef}
              value={input}
              maxLength={MAX_INPUT}
              rows={1}
              onChange={(e) => setInput(e.target.value)}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData?.files ?? []);
                if (files.length > 0) {
                  e.preventDefault();
                  void addFiles(files);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                  return;
                }
                if (e.key === "Escape" && busy) {
                  e.preventDefault();
                  stop();
                  return;
                }
                if (e.key === "Escape") setInput("");
              }}
              placeholder="Ask the executive… (Enter to send · Shift+Enter for a newline · / focuses here)"
              disabled={busy}
              aria-label="Type a message"
            />
            {busy ? (
              <button className="action stop" onClick={stop}>Stop</button>
            ) : (
              <button className="action" disabled={!input.trim() && attachments.length === 0} onClick={() => void send(input)}>Send</button>
            )}
          </div>
          <div className="composer-foot">
            <span className="muted">{input.length > MAX_INPUT * 0.8 ? `${input.length}/${MAX_INPUT} characters` : ""}</span>
            <span className="muted">{MODELS.find((x) => x.id === model)?.hint ?? ""}</span>
          </div>
        </div>
      </section>

      {/* ---------- context rail ---------- */}
      <aside className="chat3-rail" aria-label="Live context">
        <div className="tabs row">
          {(["decisions", "approvals", "contradictions", "daemon"] as const).map((t) => (
            <button key={t} className={`mini ${rail === t ? "active" : ""}`} onClick={() => setRail(t)}>
              {t}
            </button>
          ))}
        </div>

        {rail === "decisions" && (
          <>{/*­ */}<RailBlock title={`Decisions (${decisions.length})`}>
            {decisions.length === 0 ? <div className="muted">No decisions yet.</div> : decisions.map((d, i) => (
              <button key={i} className="rail-item rail-q" onClick={() => void send(`What's the context behind "${String(d.title ?? "this decision")}"?`)}>
                <div className="rail-title">{String(d.title ?? "Untitled")}</div>
                {d.created_at ? <div className="muted">{timeAgo(String(d.created_at))}</div> : null}
              </button>
            ))}
          </RailBlock></>
        )}

        {rail === "approvals" && (
          <RailBlock title={`Approvals (${pendingApprovals.length})`}>
            {pendingApprovals.length === 0 ? <div className="muted">No pending approvals.</div> : pendingApprovals.map((a, i) => (
              <div key={i} className="rail-item">
                <div className="rail-title">{String(a.title ?? "Approval")}</div>
                <div className="muted" style={{ fontSize: 11, margin: "2px 0" }}>{String(a.action_label ?? a.status ?? "")}</div>
                <div className="row" style={{ gap: 4 }}>
                  <button className="mini" onClick={() => void send(`Show pending approval: ${String(a.title ?? "")}`)}>ask</button>
                </div>
              </div>
            ))}
          </RailBlock>
        )}

        {rail === "contradictions" && (
          <>{/* */}<RailBlock title={`Contradictions (${openContradictions.length})`}>
            {openContradictions.length === 0 ? <div className="muted">No open contradictions — all clear.</div> : openContradictions.map((c, i) => (
              <button key={i} className="rail-item rail-q" onClick={() => void send(`Summarize the contradiction: ${String(c.subject_a ?? "")} vs ${String(c.subject_b ?? "")} (${String(c.claim_a ?? "")} / ${String(c.claim_b ?? "")})`)}>
                <div className="rail-title">{String(c.subject_a ?? "…")} vs {String(c.subject_b ?? "…")}</div>
                <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{String(c.claim_a ?? "")}</div>
              </button>
            ))}
          </RailBlock></>
        )}

        {rail === "daemon" && (
          <>{/* */}<RailBlock title={`Local daemon`}>
            <RailItem label="Status">
              <span className={`badge ${localAgent?.online ? "ok" : localAgent?.online === false ? "fail" : ""}`}>
                {localAgent?.online ? "online" : localAgent?.online === false ? "offline" : "unknown"}
              </span>
            </RailItem>
            <RailItem label="Last seen">
              {localAgent?.seenAgoMs != null ? timeAgo(new Date(Date.now() - localAgent.seenAgoMs).toISOString()) : "—"}
            </RailItem>
            <RailItem label="Version">{localAgent?.version ?? "—"}</RailItem>
            <RailItem label="Pending">{localAgent?.pending ?? 0}</RailItem>
            {localAgent?.online && (
              <button className="mini" style={{ marginTop: 8 }} onClick={() => void send("What is the local daemon working on right now?")}>ask what it's doing</button>
            )}
          </RailBlock></>
        )}
      </aside>
    </div>
  );
}

// ---- small presentational helpers ------------------------------------------

/** What the agent is doing right now (tool name / reasoning / thinking). */
function liveStatus(msgs: Msg[]): string {
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== "assistant") return "";
  if (last.status) return last.status;
  if (last.reasoning && !last.content) return "reasoning";
  return "";
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div className="chat3-group-label">{label}</div>
      {children}
    </div>
  );
}

interface MessageRowProps {
  m: Msg;
  first: boolean;
  live: boolean;
  canRegenerate: boolean;
  editing: boolean;
  editText: string;
  onEditText: (v: string) => void;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onCopy: (text: string) => void;
  copied: boolean;
  onRegenerate: () => void;
  onRate: (v: number) => void;
}

/**
 * One transcript row. Memoized (gap 13/25): appending stream deltas only
 * re-renders the live bubble instead of re-parsing every message's markdown.
 */
const MessageRow = memo(function MessageRow({
  m, first, live, canRegenerate, editing, editText, onEditText, onStartEdit, onSaveEdit, onCancelEdit, onCopy, copied, onRegenerate, onRate,
}: MessageRowProps) {
  const assistant = m.role === "assistant";
  const [showReasoning, setShowReasoning] = useState(false);
  const emptyLive = live && !m.content && !m.error;
  return (
    <div className={`msg3 msg-group ${m.role} ${first ? "first-in-group" : ""} ${editing ? "editing" : ""}`} data-regenerating={live ? "1" : undefined}>
      <div className="msg3-avatar" aria-hidden="true">{assistant ? "Z" : "F"}</div>
      <div className="msg3-body">
        <div className="msg3-meta">
          <span>{assistant ? "Zarlino" : "Founder"}</span>
          {m.created_at && (
            <span className="muted" title={new Date(m.created_at).toLocaleString()}>
              {" "}· <time>{clockOf(m.created_at)}</time>
            </span>
          )}
          {assistant && m.model && <span className="muted msg-model"> · {m.model === "deepseek-reasoner" ? "V4 Pro" : "V4 Flash"}</span>}
          {m.cancelled && <span className="badge warn">stopped</span>}
        </div>
        {m.attachments && m.attachments.length > 0 && (
          <div className="attach-row tight">
            {m.attachments.map((a) => (
              <span className="chip attach-chip" key={a.id} title={a.name}>{a.name}</span>
            ))}
          </div>
        )}
        {assistant && m.reasoning ? (
          <div className="reasoning">
            <button className="mini" aria-expanded={showReasoning} onClick={() => setShowReasoning((v) => !v)}>
              {showReasoning ? "hide reasoning" : "reasoning"}
            </button>
            {showReasoning && <pre className="reasoning-body">{m.reasoning}</pre>}
          </div>
        ) : null}
        <div className="msg3-content" dir="auto">
          {editing ? (
            <div className="edit-box">
              <textarea
                value={editText}
                onChange={(e) => onEditText(e.target.value)}
                rows={Math.min(12, Math.max(3, editText.split("\n").length))}
                aria-label="Edit message"
                autoFocus
              />
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                <button className="mini" onClick={onSaveEdit}>Save and resend</button>
                <button className="mini" onClick={onCancelEdit}>Cancel</button>
              </div>
            </div>
          ) : emptyLive ? (
            <div className="thinking">
              <span className="dot" /><span className="dot" /><span className="dot" /> {m.status ?? "thinking"}…
            </div>
          ) : assistant ? (
            <Markdown text={m.content} caret={live} />
          ) : (
            <span className="user-text">{m.content}</span>
          )}
          {m.error && <div className="error-box" role="alert">{m.error}</div>}
        </div>
        <div className="msg-tools">
          {m.content && (
            <button className={`mini ${copied ? "copied" : ""}`} aria-label="Copy message" onClick={() => onCopy(m.content)}>
              {copied ? "copied" : "copy"}
            </button>
          )}
          {!assistant && m.id && <button className="mini" aria-label="Edit and resend this message" onClick={onStartEdit}>edit</button>}
          {assistant && canRegenerate && <button className="mini" aria-label="Regenerate this reply" onClick={onRegenerate}>regenerate</button>}
          {assistant && m.id && (
            <>
              <button className={`mini ${m.rating === 1 ? "on" : ""}`} aria-label="Good answer" aria-pressed={m.rating === 1} onClick={() => onRate(1)}>up</button>
              <button className={`mini ${m.rating === -1 ? "on" : ""}`} aria-label="Bad answer" aria-pressed={m.rating === -1} onClick={() => onRate(-1)}>down</button>
            </>
          )}
          {assistant && canRegenerate && <span className="edge-label muted">re-roll ready</span>}
        </div>
      </div>
    </div>
  );
});

function SessionRow({
  s, active, onOpen, onDelete, onPin, onRename, pinned,
}: {
  s: ChatSession;
  active: boolean;
  onOpen: () => void;
  onDelete: () => void;
  onPin: () => void;
  onRename: () => void;
  pinned: boolean;
}) {
  const title = sessionTitle(s);
  return (
    <div
      className={`chat3-session ${active ? "active" : ""}`}
      role="option"
      aria-selected={active}
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="chat3-session-title" title={title}>{title}</div>
      <div className="chat3-session-meta">
        <span>{timeAgo(s.last_at)} · {s.message_count} msg</span>
        <span className="row" style={{ gap: 4 }} onClick={(e) => e.stopPropagation()}>
          <button className="mini" title="Rename" aria-label={`Rename ${title}`} onClick={onRename}>rename</button>
          <button className="mini" title={pinned ? "Unpin" : "Pin"} aria-label={pinned ? "Unpin conversation" : "Pin conversation"} onClick={onPin}>{pinned ? "unpin" : "pin"}</button>
          <button className="mini" title="Delete" aria-label={`Delete ${title}`} onClick={onDelete}>del</button>
        </span>
      </div>
    </div>
  );
}

function RailBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 8 }}>
      <h4>{title}</h4>
      {children}
    </div>
  );
}

function RailItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
      <span className="muted">{label}</span>
      <span>{children}</span>
    </div>
  );
}
