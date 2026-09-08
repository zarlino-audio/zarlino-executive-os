/** Reviews — the remote operator's vetting queue for produced work.
 * Sound A/B comparisons (listen + pick), UI screenshots/reports (look + sign
 * off), documents and build artifacts. Everything is served from the cloud so
 * the operator needs no access to the dev machine.
 */
import { useEffect, useState } from "react";
import { api, type DataBundle, type ReviewItem } from "../api";
import { Badge, timeAgo } from "../lib/entertain";

interface ViewProps {
  data: DataBundle;
  mutate: () => Promise<void>;
  notify: (msg: string, ok?: boolean) => void;
}

const KINDS: Record<string, { label: string; emoji: string }> = {
  sound: { label: "Sound", emoji: "🎧" },
  ui: { label: "UI", emoji: "🎨" },
  document: { label: "Document", emoji: "📄" },
  build: { label: "Build", emoji: "🏗️" },
};

const STATUS_TONE: Record<string, "ok" | "fail" | "warn"> = {
  PENDING: "warn",
  APPROVED: "ok",
  REJECTED: "fail",
  NEEDS_WORK: "warn",
};

/** Fetch a file and produce an object URL (for audio/image playback). */
function useFileUrl(fileId?: string): { url: string | null; loading: boolean; err: string } {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    let objectUrl: string | null = null;
    let alive = true;
    if (!fileId) {
      setUrl(null);
      return;
    }
    setLoading(true);
    setErr("");
    api
      .getFile(fileId)
      .then((f) => {
        if (!alive) return;
        if (!f.data_base64) {
          setErr("File has no embedded data");
          return;
        }
        const mime = f.mime ?? "application/octet-stream";
        objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(f.data_base64), (c) => c.charCodeAt(0))], { type: mime }));
        setUrl(objectUrl);
      })
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileId]);
  return { url, loading, err };
}

function SoundVet({ payload }: { payload: Record<string, unknown> }) {
  const a = useFileUrl(String(payload.audioA ?? ""));
  const b = useFileUrl(String(payload.audioB ?? ""));
  return (
    <div className="row" style={{ gap: 14, flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div className="worker-label">A — reference / dry</div>
        {a.loading && <p className="muted">loading…</p>}
        {a.err && <p className="worker-text err">{a.err}</p>}
        {a.url && <audio controls src={a.url} style={{ width: "100%" }} />}
      </div>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div className="worker-label">B — candidate / processed</div>
        {b.loading && <p className="muted">loading…</p>}
        {b.err && <p className="worker-text err">{b.err}</p>}
        {b.url && <audio controls src={b.url} style={{ width: "100%" }} />}
      </div>
    </div>
  );
}

function UiVet({ payload }: { payload: Record<string, unknown> }) {
  const img = useFileUrl(String(payload.image ?? ""));
  const report = String(payload.report ?? "");
  return (
    <div>
      {img.loading && <p className="muted">loading image…</p>}
      {img.err && <p className="worker-text err">{img.err}</p>}
      {img.url && <img src={img.url} alt="UI under review" style={{ maxWidth: "100%", maxHeight: 360, borderRadius: 8, border: "1px solid var(--border)" }} />}
      {report && <pre className="worker-text" style={{ marginTop: 8 }}>{report}</pre>}
    </div>
  );
}

export function ReviewsView({ data, mutate, notify }: ViewProps) {
  const reviews = data.reviews ?? [];
  const [filter, setFilter] = useState<string>("ALL");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // Manual submission (documents / anything the operator wants vetted).
  const [mkKind, setMkKind] = useState("document");
  const [mkTitle, setMkTitle] = useState("");
  const [mkDesc, setMkDesc] = useState("");

  const filtered = filter === "ALL" ? reviews : reviews.filter((r) => r.status === filter);
  const pending = reviews.filter((r) => r.status === "PENDING").length;

  const decide = async (r: ReviewItem, status: string) => {
    setBusy(true);
    try {
      await api.decideReview(r.id, status, (notes[r.id] ?? "").trim());
      await mutate();
      notify(`Review ${status.toLowerCase()}`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), false);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!mkTitle.trim() || busy) return;
    setBusy(true);
    try {
      await api.createReview(mkKind, mkTitle.trim(), mkDesc.trim(), {});
      setMkTitle("");
      setMkDesc("");
      await mutate();
      notify("Review filed");
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <h2>🎧 Reviews — vet sound & UI</h2>
          <Badge tone="warn">{pending} pending</Badge>
        </div>
        <p className="muted">
          The Executive files reviews when it produces something you should hear or see — sound A/B comparisons, plugin UI,
          documents, build artifacts. Listen / look and approve, reject, or ask for work. No local machine needed.
        </p>
        <div className="row tabs" style={{ marginTop: 8 }}>
          {["ALL", "PENDING", "APPROVED", "REJECTED", "NEEDS_WORK"].map((s) => (
            <button key={s} className={`ghost ${filter === s ? "active" : ""}`} onClick={() => setFilter(s)}>
              {s.replace("_", " ")}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>File a review</h2>
        <div className="row">
          <select value={mkKind} onChange={(e) => setMkKind(e.target.value)} className="sel">
            <option value="document">Document</option>
            <option value="sound">Sound</option>
            <option value="ui">UI</option>
            <option value="build">Build</option>
          </select>
          <input value={mkTitle} onChange={(e) => setMkTitle(e.target.value)} placeholder="Title — e.g. 'Vet this release note'" style={{ flex: 1 }} />
          <input value={mkDesc} onChange={(e) => setMkDesc(e.target.value)} placeholder="What to verify…" style={{ flex: 1 }} />
          <button className="action" onClick={submit} disabled={busy || !mkTitle.trim()}>File</button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card">
          <p className="muted">{filter === "ALL" ? "No review items yet — the Executive files them when it produces sound or UI work." : `No ${filter.replace("_", " ").toLowerCase()} reviews.`}</p>
        </div>
      ) : (
        filtered.map((r) => {
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(r.payload_json ?? "{}") as Record<string, unknown>;
          } catch { /* bad payload — show nothing */ }
          const k = KINDS[r.kind] ?? { label: r.kind, emoji: "📦" };
          const isPending = r.status === "PENDING";
          return (
            <div className="card" key={r.id}>
              <div className="row" style={{ justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div>
                  <div className="row" style={{ gap: 8, alignItems: "center" }}>
                    <span style={{ fontSize: 18 }}>{k.emoji}</span>
                    <h2 style={{ margin: 0 }}>{r.title}</h2>
                  </div>
                  <p className="muted" style={{ marginTop: 4 }}>
                    <Badge tone={STATUS_TONE[r.status] ?? "warn"}>{r.status.replace("_", " ")}</Badge>{" "}
                    <Badge>{k.label}</Badge> {timeAgo(r.created_at)}
                    {r.decided_by ? <> · by {r.decided_by} {r.decided_at ? timeAgo(r.decided_at) : ""}</> : null}
                  </p>
                </div>
              </div>
              {r.description ? <p>{r.description}</p> : null}
              {r.kind === "sound" ? <SoundVet payload={payload} /> : null}
              {r.kind === "ui" ? <UiVet payload={payload} /> : null}
              {r.note ? (
                <div className="worker-block" style={{ marginTop: 8 }}>
                  <div className="worker-label">Operator note</div>
                  <pre className="worker-text">{r.note}</pre>
                </div>
              ) : null}
              {isPending && (
                <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: "wrap" }}>
                  <input
                    placeholder="Verdict note (optional)…"
                    value={notes[r.id] ?? ""}
                    onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                    style={{ flex: 1, minWidth: 200 }}
                  />
                  <button className="ghost" disabled={busy} onClick={() => decide(r, "APPROVED")}>✅ Approve</button>
                  <button className="ghost" disabled={busy} onClick={() => decide(r, "NEEDS_WORK")}>🔁 Needs work</button>
                  <button className="ghost" disabled={busy} onClick={() => decide(r, "REJECTED")}>❌ Reject</button>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
