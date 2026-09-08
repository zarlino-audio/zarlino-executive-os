/** Knowledge views: Doctrine & Policies, Memory, Calendar, Notes/Reminders/Contacts. */
import { useMemo, useState } from "react";
import { api, type DataBundle } from "../api";
import { Badge, timeAgo } from "../lib/entertain";

interface ViewProps {
  data: DataBundle;
  mutate: () => Promise<void>;
  notify: (msg: string, ok?: boolean) => void;
}

// ---- Doctrine ---------------------------------------------------------------

export function Doctrine({ data }: ViewProps) {
  const doctrine = data.doctrine ?? [];
  const policies = data.policies ?? [];
  return (
    <div>
      <div className="card">
        <h2>Doctrine</h2>
        {doctrine.length === 0 ? <p className="muted">No active doctrine.</p> : doctrine.map((d, i) => (
          <div className="metric" key={i} style={{ marginBottom: 8 }}>
            <div className="value" style={{ fontSize: 13 }}><span className="mono">{String(d.code ?? "")}</span> — {String(d.principle ?? "")}</div>
            <div className="key">{String(d.rationale ?? "")} · {String(d.category ?? "")}</div>
          </div>
        ))}
      </div>
      <div className="card">
        <h2>Policies</h2>
        {policies.length === 0 ? <p className="muted">No policies.</p> : (
          <table>
            <thead>
              <tr><th>Code</th><th>Title</th><th>Body</th></tr>
            </thead>
            <tbody>
              {policies.map((p, i) => (
                <tr key={i}>
                  <td className="mono">{String(p.code ?? "")}</td>
                  <td>{String(p.title ?? "")}</td>
                  <td className="muted">{String(p.body ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---- Memory -----------------------------------------------------------------

export function MemoryView({ data }: ViewProps) {
  const memories = data.memories ?? [];
  const byLayer = useMemo(() => {
    const m = new Map<string, typeof memories>();
    for (const mem of memories) {
      const layer = String(mem.layer ?? "longterm");
      if (!m.has(layer)) m.set(layer, []);
      m.get(layer)!.push(mem);
    }
    return [...m.entries()];
  }, [memories]);
  return (
    <div>
      {byLayer.length === 0 ? (
        <p className="muted">No memories stored.</p>
      ) : (
        byLayer.map(([layer, items]) => (
          <div className="card" key={layer}>
            <h2 className="cap">{layer}</h2>
            {items.slice(0, 50).map((mem, i) => (
              <div className="memory-row" key={i}>
                <span className="muted mono" style={{ marginRight: 8 }}>{String(mem.confidence ?? "")}</span>
                {String(mem.content ?? "")}
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

// ---- Calendar ---------------------------------------------------------------

export function CalendarView({ data, mutate, notify }: ViewProps) {
  const events = data.calendar ?? [];
  const [title, setTitle] = useState("");
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      await api.addCalendarEvent(title.trim(), `${day}T09:00:00.000Z`, `${day}T10:00:00.000Z`);
      setTitle("");
      await mutate();
      notify("Event added");
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), false);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this calendar event?")) return;
    try {
      await api.deleteCalendarEvent(id);
      await mutate();
      notify("Event deleted");
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), false);
    }
  };

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const dayEvents = events
    .filter((e) => String(e.start_at ?? "").startsWith(day))
    .sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)));

  // Build a month grid for the current month.
  const [year, month] = [Number(day.slice(0, 4)), Number(day.slice(5, 7))];
  const first = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const startDow = first.getDay();
  const cells: Array<number | null> = [
    ...Array.from({ length: startDow }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  return (
    <div>
      <div className="card">
        <h2>Add event</h2>
        <div className="row">
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} style={{ width: 160 }} />
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Event title…" style={{ flex: 1 }} />
          <button className="action" onClick={add} disabled={busy || !title.trim()}>Add</button>
        </div>
      </div>
      <div className="card">
        <h2>{new Date(year, month - 1).toLocaleString(undefined, { month: "long", year: "numeric" })}</h2>
        <div className="cal-grid">
          {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
            <div key={d} className="cal-dow">{d}</div>
          ))}
          {cells.map((d, i) => {
            if (d === null) return <div key={i} className="cal-cell dim" />;
            const key = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
            const has = events.some((e) => String(e.start_at ?? "").startsWith(key));
            return (
              <button key={i} className={`cal-cell ${key === today ? "today" : ""} ${key === day ? "selected" : ""} ${has ? "has" : ""}`} onClick={() => setDay(key)}>
                {d}
              </button>
            );
          })}
        </div>
      </div>
      <div className="card">
        <h2>{day} — agenda</h2>
        {dayEvents.length === 0 ? (
          <p className="muted">No events this day.</p>
        ) : (
          dayEvents.map((e, i) => (
            <div className="row agenda-row" key={i}>
              <span className="mono muted">{new Date(String(e.start_at ?? "")).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
              <span style={{ flex: 1 }}>{String(e.title ?? "")}</span>
              <button className="mini" onClick={() => remove(String(e.id))}>✕</button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---- Notes / Reminders / Contacts -------------------------------------------

export function NotesView({ data, mutate, notify }: ViewProps) {
  const [tab, setTab] = useState<"notes" | "reminders" | "contacts">("notes");
  const notes = data.notes ?? [];
  const reminders = data.reminders ?? [];
  const contacts = data.contacts ?? [];

  const [noteTitle, setNoteTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const [remTitle, setRemTitle] = useState("");
  const [remDue, setRemDue] = useState(() => new Date().toISOString().slice(0, 10));
  const [ctcName, setCtcName] = useState("");
  const [ctcRole, setCtcRole] = useState("");
  const [ctcCompany, setCtcCompany] = useState("");
  const [ctcEmail, setCtcEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const addNote = async () => {
    if (!noteTitle.trim() || busy) return;
    setBusy(true);
    try {
      await api.addNote(noteTitle.trim(), noteBody);
      setNoteTitle(""); setNoteBody("");
      await mutate();
    } catch (e) { notify(e instanceof Error ? e.message : String(e), false); } finally { setBusy(false); }
  };
  const addReminder = async () => {
    if (!remTitle.trim() || busy) return;
    setBusy(true);
    try {
      await api.addReminder(remTitle.trim(), `${remDue}T09:00:00.000Z`);
      setRemTitle("");
      await mutate();
    } catch (e) { notify(e instanceof Error ? e.message : String(e), false); } finally { setBusy(false); }
  };
  const addContact = async () => {
    if (!ctcName.trim() || busy) return;
    setBusy(true);
    try {
      await api.addContact(ctcName.trim(), ctcRole.trim(), ctcCompany.trim(), ctcEmail.trim());
      setCtcName(""); setCtcRole(""); setCtcCompany(""); setCtcEmail("");
      await mutate();
    } catch (e) { notify(e instanceof Error ? e.message : String(e), false); } finally { setBusy(false); }
  };

  const del = async (fn: () => Promise<unknown>, okMsg: string, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    try {
      await fn();
      await mutate();
      notify(okMsg);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), false);
    }
  };

  const overdue = reminders.filter((r) => !Number(r.done) && String(r.due_at ?? "") < new Date().toISOString()).length;
  const sortedReminders = [...reminders].sort((a, b) => {
    if (Number(a.done) !== Number(b.done)) return Number(a.done) - Number(b.done);
    return String(a.due_at ?? "").localeCompare(String(b.due_at ?? ""));
  });

  return (
    <div>
      <div className="row tabs">
        {(["notes", "reminders", "contacts"] as const).map((t) => (
          <button key={t} className={`ghost ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t} {t === "reminders" && overdue > 0 ? <span className="overdue-dot" title={`${overdue} overdue`}>{overdue}</span> : null}
          </button>
        ))}
      </div>

      {tab === "notes" && (
        <div className="card">
          <h2>Notes</h2>
          <div className="row">
            <input value={noteTitle} onChange={(e) => setNoteTitle(e.target.value)} placeholder="Note title…" style={{ flex: 1 }} />
          </div>
          <textarea value={noteBody} onChange={(e) => setNoteBody(e.target.value)} placeholder="Body…" style={{ marginTop: 8 }} />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="action" onClick={addNote} disabled={busy || !noteTitle.trim()}>Add note</button>
          </div>
          {notes.length === 0 ? <p className="muted">No notes.</p> : (
            <div className="notes-list">
              {notes.map((n, i) => (
                <div className="note-card" key={i}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <b>{String(n.title ?? "")}</b>
                    <button className="mini" onClick={() => void del(() => api.deleteNote(String(n.id)), "Note deleted", "Delete this note?")}>✕</button>
                  </div>
                  {String(n.body ?? "") && <p className="muted">{String(n.body ?? "")}</p>}
                  {Number(n.pinned) === 1 && <Badge>📌 pinned</Badge>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "reminders" && (
        <div className="card">
          <h2>Reminders</h2>
          <div className="row">
            <input value={remTitle} onChange={(e) => setRemTitle(e.target.value)} placeholder="Reminder…" style={{ flex: 1 }} />
            <input type="date" value={remDue} onChange={(e) => setRemDue(e.target.value)} style={{ width: 160 }} />
            <button className="action" onClick={addReminder} disabled={busy || !remTitle.trim()}>Add</button>
          </div>
          {reminders.length === 0 ? <p className="muted">No reminders.</p> : (
            <table>
              <thead>
                <tr><th>Title</th><th>Due</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {sortedReminders.map((r, i) => (
                  <tr key={i}>
                    <td style={Number(r.done) ? { textDecoration: "line-through", opacity: 0.6 } : undefined}>{String(r.title ?? "")}</td>
                    <td className="mono muted">{String(r.due_at ?? "").slice(0, 10)} {Number(r.done) ? "" : timeAgo(String(r.due_at))}</td>
                    <td><Badge tone={Number(r.done) ? "ok" : String(r.due_at ?? "") < new Date().toISOString() ? "fail" : "warn"}>{Number(r.done) ? "done" : "due"}</Badge></td>
                    <td>
                      {!Number(r.done) && <button className="mini" onClick={async () => { try { await api.markReminderDone(String(r.id)); await mutate(); } catch (e) { notify(e instanceof Error ? e.message : String(e), false); } }}>✔</button>}
                      <button className="mini" onClick={() => void del(() => api.deleteReminder(String(r.id)), "Reminder deleted", "Delete this reminder?")}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "contacts" && (
        <div className="card">
          <h2>Contacts</h2>
          <div className="row">
            <input value={ctcName} onChange={(e) => setCtcName(e.target.value)} placeholder="Name" style={{ flex: 1 }} />
            <input value={ctcRole} onChange={(e) => setCtcRole(e.target.value)} placeholder="Role" style={{ flex: 1 }} />
            <input value={ctcCompany} onChange={(e) => setCtcCompany(e.target.value)} placeholder="Company" style={{ flex: 1 }} />
            <input value={ctcEmail} onChange={(e) => setCtcEmail(e.target.value)} placeholder="Email" style={{ flex: 1 }} />
            <button className="action" onClick={addContact} disabled={busy || !ctcName.trim()}>Add</button>
          </div>
          {contacts.length === 0 ? <p className="muted">No contacts.</p> : (
            <table>
              <thead>
                <tr><th>Name</th><th>Role</th><th>Company</th><th>Email</th></tr>
              </thead>
              <tbody>
                {contacts.map((c, i) => (
                  <tr key={i}>
                    <td>{String(c.name ?? "")}</td>
                    <td className="muted">{String(c.role ?? "")}</td>
                    <td className="muted">{String(c.company ?? "")}</td>
                    <td className="mono muted">{String(c.email ?? "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
