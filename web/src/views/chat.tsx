/**
 * Executive chat â€” a three-panel founder console organised for easy use:
 *   left   sessions sidebar : New chat, a search box to filter past
 *                             conversations, and conversation history grouped by
 *                             date (Pinned / Today / Yesterday / This week /
 *                             Earlier). Sessions can be pinned for quick access.
 *   center main thread      : streaming replies (SSE), markdown, avatars,
 *                             timestamps, copy, thinking phases, stop, quick
 *                             prompt chips, suggestion cards, AND a message-search
 *                             box to filter the active thread.
 *   right  context rail     : live decisions, pending approvals, contradictions,
 *                             and local daemon status surfaced from the bundle â€”
 *                             tap any item to ask about it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, chatSse, type ChatSession, type Contradiction, type DataBundle } from "../api";
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

const PIN_KEY = "exec_os_chat_pins";

type Msg = { role: "user" | "assistant"; content: string; created_at?: string };

function sessionTitle(s: ChatSession): string {
  const raw = s.last_message || s.session_id;
  if (raw !== s.session_id) {
    const firstLine = raw.split("\\n")[0] || "";
    return firstLine.length > 56 ? firstLine.slice(0, 56) + "..." : firstLine;
  }
  return raw;
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

const GROUP_ORDER = ["Today", "Yesterday", "This week", "Earlier"];

export function ChatView({ data, mutate: _mutate, notify }: ViewProps) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionId, setSessionId] = useState<string>(() => localStorage.getItem("exec_os_chat_session") ?? "default");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [sessionQuery, setSessionQuery] = useState("");
  const [msgQuery, setMsgQuery] = useState("");
  const [showMsgSearch, setShowMsgSearch] = useState(false);
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
  const sessionIdRef = useRef(sessionId);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { localStorage.setItem("exec_os_chat_rail", rail); }, [rail]);
  useEffect(() => { localStorage.setItem(PIN_KEY, JSON.stringify(Array.from(pins))); }, [pins]);

  const loadSessions = useCallback(async () => {
    try {
      const r = await api.chatSessions();
      setSessions(r.sessions);
    } catch {
      /* non-fatal */
    }
  }, []);

  const loadHistory = useCallback(async (sid: string) => {
    try {
      const r = await api.chatMessages(sid);
      setMessages(r.messages.map((m) => ({ role: m.role, content: m.content, created_at: m.created_at })));
    } catch {
      setMessages([]);
    } finally {
      setHistoryLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    localStorage.setItem("exec_os_chat_session", sessionId);
    setHistoryLoaded(false);
    setMsgQuery("");
    setShowMsgSearch(false);
    void loadHistory(sessionId);
  }, [sessionId, loadHistory]);

  useEffect(() => {
    if (busy) {
      const t = setInterval(() => setElapsed((e) => e + 1), 1000);
      return () => clearInterval(t);
    }
    setElapsed(0);
  }, [busy]);

  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, streaming]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(""), 8000);
    return () => clearTimeout(t);
  }, [error]);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || busy) return;
    const sid = sessionIdRef.current; // capture - the founder may switch sessions mid-stream
    setInput("");
    setError("");
    setMessages((m) => [...m, { role: "user", content }]);
    setBusy(true);
    setStreaming(true);
    const acc: string[] = [];
    abortRef.current = new AbortController();
    try {
      const start = await api.chatStreamStart(content, sid);
      setMessages((m) => [...m, { role: "assistant", content: "" }]);
      await chatSse(
        start.streamId,
        (chunk) => {
          if (sessionIdRef.current !== sid) return; // dropped - session changed
          acc.push(chunk);
          const joined = acc.join("");
          setMessages((m) => {
            const next = [...m];
            if (next.length > 0 && next[next.length - 1]!.role === "assistant") {
              next[next.length - 1] = { role: "assistant", content: joined };
            }
            return next;
          });
        },
        abortRef.current.signal,
      );
      await loadHistory(sid);
      await loadSessions();
    } catch (e) {
      const isAbort = e instanceof DOMException && e.name === "AbortError";
      if (isAbort) {
        await loadHistory(sid);
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      notify(`Chat failed: ${msg}`, false);
    } finally {
      setBusy(false);
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    setBusy(false);
    setStreaming(false);
  };

  const newChat = async () => {
    const sid = `chat_${Date.now().toString(36)}`;
    localStorage.setItem("exec_os_chat_session", sid);
    setSessionId(sid);
    setMessages([]);
    setHistoryLoaded(true);
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

  const copy = async (text: string) => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      notify("Copied");
    } catch {
      notify("Could not copy to clipboard", false);
    }
  };

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
            (s.last_message || s.session_id).toLowerCase().includes(q) ||
            s.session_id.toLowerCase().includes(q),
        )
      : sessions;
    return list.sort((a, b) => (b.last_at || "").localeCompare(a.last_at || ""));
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

  const currentSession = sessions.find((s) => s.session_id === sessionId);

  // ---- render --------------------------------------------------------------

  return (
    <div className="chat3">
      {/* ---------- sessions sidebar ---------- */}
      <aside className="chat3-side" aria-label="Conversations">
        <div className="chat3-side-head">
          <button className="action" style={{ width: "100%" }} onClick={() => void newChat()}>
            âœš New chat
          </button>
          <input
            value={sessionQuery}
            onChange={(e) => setSessionQuery(e.target.value)}
            placeholder="Search conversationsâ€¦"
            aria-label="Search conversations"
            style={{ marginTop: 10 }}
          />
          {sessionQuery.trim() !== "" && (
            <button className="mini" style={{ width: "100%", marginTop: 6 }} onClick={() => setSessionQuery("")}>
              Clear search
            </button>
          )}
        </div>

        {pinnedSessions.length > 0 && (
          <Section label="ðŸ“Œ Pinned">
            {pinnedSessions.map((s) => (
              <SessionRow key={s.session_id} s={s} active={s.session_id === sessionId} onOpen={() => setSessionId(s.session_id)} onDelete={() => void deleteSession(s.session_id)} onPin={() => togglePin(s.session_id)} pinned />
            ))}
          </Section>
        )}

        {pinnedSessions.length > 0 && mainSessions.length > 0 && <div className="chat3-sep" />}

        {grouped.map(({ group, items }) => (
          <Section key={group} label={group}>
            {items.map((s) => (
              <SessionRow key={s.session_id} s={s} active={s.session_id === sessionId} onOpen={() => setSessionId(s.session_id)} onDelete={() => void deleteSession(s.session_id)} onPin={() => togglePin(s.session_id)} pinned={false} />
            ))}
          </Section>
        ))}

        {!historyLoaded || (filteredSessions.length === 0 && pinnedSessions.length === 0) ? (
          <div className="muted" style={{ padding: "10px 6px", fontSize: 12 }}>
            {filteredSessions.length === 0 ? "No conversations match." : "Loading conversationsâ€¦"}
          </div>
        ) : null}
      </aside>

      {/* ---------- main thread ---------- */}
      <section className="chat3-main" aria-label="Conversation">
        <div className="chat3-main-head">
          <div>
            <div className="chat3-title">
              {currentSession ? <span className="muted mono" style={{ fontSize: 11 }}>{currentSession.session_id}</span> : "New conversation"}
              <button className="mini" title={pins.has(sessionId) ? "Unpin" : "Pin this conversation"} onClick={() => togglePin(sessionId)}>
                {pins.has(sessionId) ? "ðŸ“Œ pinned" : "ðŸ“Œ pin"}
              </button>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {currentSession ? `${currentSession.message_count} messages Â· last ${timeAgo(currentSession.last_at)}` : "Start a conversation below â€” or pick one from the sidebar."}
            </div>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
            <button className="mini" title="Filter messages in this thread" onClick={() => { setShowMsgSearch((s) => !s); if (showMsgSearch) setMsgQuery(""); }}>
              {showMsgSearch ? "ðŸ” on" : "ðŸ”"}
            </button>
            <button className="mini" title="New chat" onClick={() => void newChat()}>âœš</button>
          </div>
        </div>

        {showMsgSearch && (
          <div style={{ padding: "8px 12px 0" }}>
            <input
              autoFocus
              value={msgQuery}
              onChange={(e) => setMsgQuery(e.target.value)}
              placeholder={`Search ${messages.length} messagesâ€¦`}
              aria-label="Search messages"
            />
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              {msgQuery ? `${filteredMessages.length} of ${messages.length} messages match` : "Type to filter this thread"}
            </div>
          </div>
        )}

        <div className="chat3-log" ref={logRef}>
          {error && <div className="error-box">{error}</div>}
          {!historyLoaded && (
            <div className="loading">
              <span className="dot" /><span className="dot" /><span className="dot" /> loadingâ€¦
            </div>
          )}
          {historyLoaded && filteredMessages.length === 0 && !streaming && (
            <div className="chat-hero">
              <h3 style={{ margin: "0 0 6px" }}>Zarlino Executive</h3>
              <p className="muted" style={{ margin: 0 }}>Ask about your pipeline, approvals, doctrine, or anything the daemon is working on. Quick prompts below.</p>
              <div className="suggestion-row">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="suggestion" disabled={busy} onClick={() => void send(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {filteredMessages.map((m, i) => (
            <div key={i} className={`msg3 ${m.role}`}>
              <div className="msg3-avatar">{m.role === "user" ? "ðŸ§‘" : "ðŸ¤–"}</div>
              <div className="msg3-body">
                <div className="msg3-meta">
                  <span>{m.role === "user" ? "You" : "Zarlino"}</span>
                  {m.created_at && <span className="muted"> Â· {timeAgo(m.created_at)}</span>}
                </div>
                <div className="msg3-content">
                  {m.role === "assistant" && m.content === "" && streaming ? (
                    <div className="thinking"><span className="dot" /><span className="dot" /><span className="dot" /> thinkingâ€¦</div>
                  ) : m.role === "assistant" ? (
                    <Markdown text={m.content} />
                  ) : (
                    m.content
                  )}
                </div>
                <div className="msg-tools">
                  {m.content && <button className="mini" onClick={() => void copy(m.content)}>copy</button>}
                </div>
              </div>
            </div>
          ))}
          {streaming && <div className="muted" style={{ fontSize: 11, padding: "0 12px" }}>streamingâ€¦ {elapsed}s {busy && <button className="mini" onClick={stop}>â–  stop</button>}</div>}
        </div>

        <div className="quick-row" style={{ padding: "2px 12px 0" }}>
          {QUICK_PROMPTS.map((q) => (
            <button key={q} className="quick-chip" disabled={busy} onClick={() => void send(q)}>{q}</button>
          ))}
        </div>

        <div className="chat3-composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            placeholder="Ask the executiveâ€¦ (Enter to send, Shift+Enter for newline)"
            disabled={busy}
            aria-label="Type a message"
          />
          {busy ? (
            <button className="action" style={{ background: "var(--fail)" }} onClick={stop}>&#9632; Stop</button>
          ) : (
            <button className="action" disabled={!input.trim()} onClick={() => void send(input)}>Send</button>
          )}
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
          <RailBlock title={`ðŸ§­ Decisions (${decisions.length})`}>
            {decisions.length === 0 ? <div className="muted">No decisions yet.</div> : decisions.map((d, i) => (
              <button key={i} className="rail-item rail-q" onClick={() => void send(`What's the context behind "${String(d.title ?? "this decision")}"?`)}>
                <div className="rail-title">{String(d.title ?? "Untitled")}</div>
                {d.created_at ? <div className="muted">{timeAgo(String(d.created_at))}</div> : null}
              </button>
            ))}
          </RailBlock>
        )}

        {rail === "approvals" && (
          <RailBlock title={`âœ‹ Approvals (${pendingApprovals.length})`}>
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
          <RailBlock title={`âš”ï¸ Contradictions (${openContradictions.length})`}>
            {openContradictions.length === 0 ? <div className="muted">No open contradictions â€” all clear.</div> : openContradictions.map((c, i) => (
              <button key={i} className="rail-item rail-q" onClick={() => void send(`Summarize the contradiction: ${String(c.subject_a ?? "")} vs ${String(c.subject_b ?? "")} (${String(c.claim_a ?? "")} / ${String(c.claim_b ?? "")})`)}>
                <div className="rail-title">{String(c.subject_a ?? "â€¦")} â†” {String(c.subject_b ?? "â€¦")}</div>
                <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{String(c.claim_a ?? "")}</div>
              </button>
            ))}
          </RailBlock>
        )}

        {rail === "daemon" && (
          <RailBlock title={`ðŸ–¥ï¸ Local daemon`}>
            <RailItem label="Status">
              <span className={`badge ${localAgent?.online ? "ok" : localAgent?.online === false ? "fail" : ""}`}>
                {localAgent?.online ? "online" : localAgent?.online === false ? "offline" : "unknown"}
              </span>
            </RailItem>
            <RailItem label="Last seen">
              {localAgent?.seenAgoMs != null ? timeAgo(new Date(Date.now() - localAgent.seenAgoMs).toISOString()) : "â€”"}
            </RailItem>
            <RailItem label="Version">{localAgent?.version ?? "â€”"}</RailItem>
            <RailItem label="Pending">{localAgent?.pending ?? 0}</RailItem>
            {localAgent?.online && (
              <button className="mini" style={{ marginTop: 8 }} onClick={() => void send("What is the local daemon working on right now?")}>ask what it's doing</button>
            )}
          </RailBlock>
        )}
      </aside>
    </div>
  );
}

// ---- small presentational helpers ------------------------------------------

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div className="chat3-group-label">{label}</div>
      {children}
    </div>
  );
}

function SessionRow({ s, active, onOpen, onDelete, onPin, pinned }: { s: ChatSession; active: boolean; onOpen: () => void; onDelete: () => void; onPin: () => void; pinned: boolean }) {
  return (
    <div className={`chat3-session ${active ? "active" : ""}`} onClick={onOpen}>
      <div className="chat3-session-title">{sessionTitle(s)}</div>
      <div className="chat3-session-meta">
        <span>{timeAgo(s.last_at)} Â· {s.message_count} msg</span>
        <span className="row" style={{ gap: 4 }} onClick={(e) => e.stopPropagation()}>
          <button className="mini" title={pinned ? "Unpin" : "Pin"} onClick={onPin}>{pinned ? "ðŸ“Œ" : "ðŸ“Œ"}</button>
          <button className="mini" title="Delete" onClick={() => { if (window.confirm("Delete this conversation? This cannot be undone.")) onDelete(); }}>ðŸ—‘</button>
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
