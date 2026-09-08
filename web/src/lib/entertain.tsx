/**
 * Entertainment + shared UI primitives for the Executive OS console.
 * Everything here is dependency-free and CSS-animated so it stays fast:
 *  - usePolling: interval that pauses when the tab is hidden (saves API/CPU)
 *  - BootSplash: skippable terminal intro
 *  - Confetti: pure-CSS celebration pieces
 *  - Ticker: rotating taglines
 *  - FuelGauge: AI budget gauge with quips
 *  - Markdown: safe, lightweight renderer (React escapes; we decode entities)
 *  - CommandPalette: Ctrl+K / "?" jump-to navigation
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

// ---- polling ---------------------------------------------------------------

/** Poll `fn` every `ms`; pauses while the document is hidden (battery/API saver). */
export function usePolling(fn: () => void | Promise<void>, ms: number, deps: unknown[] = []): void {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      if (document.hidden) return;
      void saved.current();
    };
    timer = setInterval(tick, ms);
    const onVis = () => {
      if (timer) {
        clearInterval(timer);
        timer = setInterval(tick, document.hidden ? 60_000 : ms);
      }
      if (!document.hidden) void saved.current();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// ---- formatters ------------------------------------------------------------

export function fmt(n: number | undefined | null, digits = 0): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function timeAgo(iso: string | undefined | null): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms) || ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ---- BootSplash ------------------------------------------------------------

const BOOT_LINES = [
  "ZARLINO EXECUTIVE OS v1.1",
  "initializing durable brain… ok",
  "loading doctrine · policies · pipeline… ok",
  "system doctor armed (14 checks)… ok",
  "productivity manager online… ok",
  "founder session: secured",
];

export function BootSplash({ onDone }: { onDone: () => void }) {
  const [line, setLine] = useState(0);
  const done = useRef(false);
  useEffect(() => {
    const t = setInterval(() => {
      setLine((l) => {
        if (l >= BOOT_LINES.length) {
          clearInterval(t);
          return l;
        }
        return l + 1;
      });
    }, 180);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (line >= BOOT_LINES.length && !done.current) {
      done.current = true;
      const t = setTimeout(onDone, 350);
      return () => clearTimeout(t);
    }
  }, [line, onDone]);
  return (
    <div className="boot-splash" onClick={onDone}>
      <div className="boot-terminal">
        {BOOT_LINES.slice(0, Math.min(line + 1, BOOT_LINES.length)).map((l, i) => (
          <div key={i} className="boot-line">{l}</div>
        ))}
        <div className="boot-cursor">▌</div>
        <div className="boot-hint">click to skip</div>
      </div>
    </div>
  );
}

// ---- Confetti --------------------------------------------------------------

const COLORS = ["#f0b429", "#3fb950", "#58a6ff", "#f85149", "#bc8cff", "#39c5cf"];

export function Confetti({ pieces = 36 }: { pieces?: number }) {
  const list = useRef(
    Array.from({ length: pieces }, (_, i) => ({
      left: Math.random() * 100,
      delay: Math.random() * 0.5,
      dur: 2.2 + Math.random() * 1.6,
      color: COLORS[i % COLORS.length],
      size: 6 + Math.random() * 6,
      rot: Math.random() * 360,
    })),
  ).current;
  return (
    <div className="confetti-layer" aria-hidden>
      {list.map((c, i) => (
        <span
          key={i}
          className="confetti"
          style={{
            left: `${c.left}%`,
            background: c.color,
            width: c.size,
            height: c.size * 0.45,
            animationDelay: `${c.delay}s`,
            animationDuration: `${c.dur}s`,
            transform: `rotate(${c.rot}deg)`,
          }}
        />
      ))}
    </div>
  );
}

// ---- Ticker ----------------------------------------------------------------

const TAGLINES = [
  "ship ZScorch · ship ZTame · ship PresenceField",
  "do more with less — productivity manager is watching the token spend",
  "system doctor auto-fixes while you sleep",
  "founder mode: you approve the irreversible stuff",
  "affiliate program: 25% of every referral sale",
  "gate 10 is the only gate the founder signs",
  "every consequential action is audited",
  "never fabricate numbers — say UNKNOWN instead",
  "the executive never moves money without approval",
  "budgets are hard caps, not suggestions",
];

export function Ticker() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % TAGLINES.length), 9000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="ticker" key={i}>
      <span className="ticker-label">● LIVE</span>
      <span className="ticker-text">{TAGLINES[i]}</span>
    </div>
  );
}

// ---- FuelGauge -------------------------------------------------------------

const FUEL_QUIPS = [
  (p: number) => (p >= 90 ? "🔥 refuel now" : p >= 60 ? "⛽ getting low" : p >= 30 ? "🚗 cruising" : "🟢 plenty of fuel"),
];

export function FuelGauge({ used, budget, label = "AI fuel" }: { used: number; budget: number; label?: string }) {
  const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
  const color = pct >= 90 ? "var(--fail)" : pct >= 60 ? "var(--warn)" : "var(--ok)";
  return (
    <div className="fuel" title={`${used.toLocaleString()} / ${budget.toLocaleString()}`}>
      <div className="fuel-head">
        <span className="fuel-label">{label}</span>
        <span className="fuel-pct" style={{ color }}>{pct}%</span>
      </div>
      <div className="fuel-bar">
        <div className="fuel-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="fuel-quip">{FUEL_QUIPS[0](pct)} · {used.toLocaleString()} used</div>
    </div>
  );
}

// ---- Markdown (safe + lightweight) -----------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function inline(s: string, key: number): ReactNode[] {
  // Split code spans first, then bold/italic on the remainder.
  const parts = s.split(/(`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith("`") && p.endsWith("`")) return <code key={`${key}-${i}`}>{p.slice(1, -1)}</code>;
    const bold = p.split(/(\*\*[^*]+\*\*)/g);
    return bold.map((b, j) => {
      if (b.startsWith("**") && b.endsWith("**")) return <strong key={`${key}-${i}-${j}`}>{b.slice(2, -2)}</strong>;
      const it = b.split(/(\*[^*]+\*)/g);
      return it.map((x, k) =>
        x.startsWith("*") && x.endsWith("*") && x.length > 2 ? <em key={`${key}-${i}-${j}-${k}`}>{x.slice(1, -1)}</em> : <span key={`${key}-${i}-${j}-${k}`}>{x}</span>,
      );
    });
  });
}

export function Markdown({ text }: { text: string }) {
  const t = decodeEntities(text);
  const lines = t.split(/\n/);
  const out: ReactNode[] = [];
  let list: string[] = [];
  let code: string[] = [];
  let inCode = false;

  const flushList = (k: number) => {
    if (list.length) {
      out.push(
        <ul key={`ul${k}`}>
          {list.map((li, i) => (
            <li key={i}>{inline(li.replace(/^[-*]\s+/, ""), k * 100 + i)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  const flushCode = (k: number) => {
    if (code.length) {
      out.push(<pre key={`pre${k}`}><code>{code.join("\n")}</code></pre>);
      code = [];
    }
  };

  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    if (line.startsWith("```")) {
      if (inCode) {
        flushCode(i);
        inCode = false;
      } else {
        flushList(i);
        inCode = true;
      }
      return;
    }
    if (inCode) {
      code.push(line);
      return;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flushCode(i);
      list.push(line);
      return;
    }
    flushList(i);
    flushCode(i);
    if (line === "") {
      out.push(<div key={i} className="md-gap" />);
    } else if (line.startsWith("### ")) {
      out.push(<h4 key={i}>{inline(line.slice(4), i)}</h4>);
    } else if (line.startsWith("## ")) {
      out.push(<h3 key={i}>{inline(line.slice(3), i)}</h3>);
    } else if (line.startsWith("# ")) {
      out.push(<h2 key={i}>{inline(line.slice(2), i)}</h2>);
    } else {
      out.push(<p key={i}>{inline(line, i)}</p>);
    }
  });
  flushList(9999);
  flushCode(9998);
  return <div className="markdown">{out}</div>;
}

// ---- CommandPalette --------------------------------------------------------

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
}

export function CommandPalette({ open, items, onClose, onPick }: { open: boolean; items: PaletteItem[]; onClose: () => void; onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);
  if (!open) return null;
  const all = items.filter((i) => i.label.toLowerCase().includes(q.toLowerCase()));
  const filtered = all.slice(0, 12);
  const more = all.length - filtered.length;
  const pick = (i: PaletteItem) => { onPick(i.id); onClose(); };
  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Jump to a view">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === "Home") { e.preventDefault(); setActive(0); }
            else if (e.key === "End") { e.preventDefault(); setActive(filtered.length - 1); }
            else if (e.key === "Enter" && filtered[active]) { pick(filtered[active]!); }
          }}
          placeholder="Jump to…"
        />
        <div className="palette-list">
          {filtered.map((i, idx) => (
            <button
              key={i.id}
              className={`palette-item ${idx === active ? "active" : ""}`}
              onMouseEnter={() => setActive(idx)}
              onClick={() => pick(i)}
            >
              <span>{i.label}</span>
              {i.hint && <span className="muted mono">{i.hint}</span>}
            </button>
          ))}
          {more > 0 && <div className="muted palette-empty">…and {more} more — refine your search</div>}
          {filtered.length === 0 && <div className="muted palette-empty">No matches</div>}
        </div>
      </div>
    </div>
  );
}

// ---- misc ------------------------------------------------------------------

export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone ?? ""}`}>{children}</span>;
}

export function useConfetti(on: boolean): boolean {
  return on;
}

export { useCallback };
