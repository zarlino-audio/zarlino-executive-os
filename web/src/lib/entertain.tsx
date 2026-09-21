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

// ---- syntax highlighting (tiny, dependency-free) ---------------------------

const HASH_COMMENT_LANGS = new Set(["python", "py", "bash", "sh", "shell", "zsh", "yaml", "yml", "toml", "rb", "ruby", "ps1", "powershell", "r", "pl", "perl", "ini", "conf"]);

const KEYWORDS = new Set([
  // JS/TS
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "class", "extends", "super", "new", "import", "from", "export", "default", "async", "await", "try", "catch", "finally", "throw", "typeof", "instanceof", "interface", "type", "enum", "implements", "public", "private", "protected", "readonly", "static", "void", "yield", "of", "in", "this",
  // Python
  "def", "elif", "lambda", "pass", "raise", "with", "as", "global", "nonlocal", "assert", "del", "yield",
  // SQL
  "select", "from", "where", "insert", "update", "delete", "join", "left", "right", "inner", "outer", "group", "order", "by", "limit", "offset", "create", "table", "alter", "drop", "index", "values", "set", "into", "on", "having", "distinct", "union", "case", "when", "then", "end",
  // Shell / misc
  "echo", "cd", "ls", "grep", "then", "fi", "done", "export", "sudo", "npm", "npx", "git",
]);

const BOOLEANS = new Set(["true", "false", "null", "undefined", "None", "True", "False", "nil", "NaN", "Infinity"]);

interface Tok { text: string; cls?: string }

/**
 * Minimal scanner that colours the constructs people actually read: comments,
 * strings, numbers, keywords, booleans, function calls and properties. It is
 * deliberately language-agnostic — it never needs to be "correct", only useful
 * — and it emits class names the stylesheet already defines (.tok-*).
 */
function highlight(code: string, langRaw: string): Tok[] {
  const lang = langRaw.toLowerCase();
  const hashComments = HASH_COMMENT_LANGS.has(lang);
  const out: Tok[] = [];
  const isWord = (c: string | undefined) => !!c && /[A-Za-z0-9_$]/.test(c);
  let i = 0;
  while (i < code.length) {
    const c = code[i]!;
    const next = code[i + 1];
    // block comment
    if (c === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end === -1 ? code.length : end + 2;
      out.push({ text: code.slice(i, stop), cls: "tok-c" });
      i = stop;
      continue;
    }
    // line comment
    if ((c === "/" && next === "/") || (hashComments && c === "#" && !isWord(code[i - 1]))) {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? code.length : end;
      out.push({ text: code.slice(i, stop), cls: "tok-c" });
      i = stop;
      continue;
    }
    // strings (single, double, backtick)
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === "\\") { j += 2; continue; }
        if (code[j] === c) { j += 1; break; }
        if (code[j] === "\n" && c !== "`") break;
        j++;
      }
      out.push({ text: code.slice(i, j), cls: "tok-str" });
      i = j;
      continue;
    }
    // number
    if (/[0-9]/.test(c) && !isWord(code[i - 1])) {
      const m = /^[0-9][0-9a-fA-F_xX.]*(?:e[+-]?\d+)?/.exec(code.slice(i));
      const text = m?.[0] ?? c;
      out.push({ text, cls: "tok-num" });
      i += text.length;
      continue;
    }
    // word
    if (isWord(c)) {
      let j = i;
      while (j < code.length && isWord(code[j])) j++;
      const word = code.slice(i, j);
      const lower = word.toLowerCase();
      let cls: string | undefined;
      if (KEYWORDS.has(word) || KEYWORDS.has(lower)) cls = "tok-kw";
      else if (BOOLEANS.has(word)) cls = "tok-bool";
      else if (code[j] === "(") cls = "tok-fn";
      else if (code[j] === ":") cls = "tok-prop";
      out.push({ text: word, cls });
      i = j;
      continue;
    }
    // tag-ish (<div …) for markup languages
    if ((lang === "html" || lang === "xml" || lang === "svg") && c === "<") {
      const m = /^<\/?[A-Za-z][\w:-]*/.exec(code.slice(i));
      if (m) {
        out.push({ text: m[0], cls: "tok-tag" });
        i += m[0].length;
        continue;
      }
    }
    // operators / punctuation
    if ("+-*/%=<>!&|^~?:;,.(){}[]".includes(c)) {
      const m = /^(=>|===|!==|==|!=|<=|>=|&&|\|\||\?\?|\+\+|--|\.\.\.|\*\*|::|->|\+=|-=|\*=|\/=|[+\-*/%=<>!&|^~?:;,.(){}[\]])/.exec(code.slice(i));
      const text = m?.[0] ?? c;
      out.push({ text, cls: /[a-z]/i.test(text) ? "tok-op" : undefined });
      i += text.length;
      continue;
    }
    out.push({ text: c });
    i++;
  }
  return out;
}

/** Fenced code block: language pill + copy button + highlighted body. */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable — no-op */
    }
  };
  const tokens = highlight(code, lang);
  return (
    <div className="md-codeblock">
      <div className="md-codeblock-head">
        <span className="md-lang">{lang || "text"}</span>
        <button type="button" className={copied ? "copied-ok" : ""} onClick={() => void copy()} aria-label={copied ? "Code copied" : "Copy code"}>
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre>
        <code>
          {tokens.map((tk, i) => (tk.cls ? <span key={i} className={tk.cls}>{tk.text}</span> : <span key={i}>{tk.text}</span>))}
        </code>
      </pre>
    </div>
  );
}

// ---- markdown --------------------------------------------------------------

/** Only these URL shapes are rendered as links/images (no javascript: etc.). */
function safeUrl(url: string): boolean {
  return /^(https?:\/\/|mailto:|data:image\/)/i.test(url.trim());
}

/** Turn bare http(s) URLs into anchors so pasted links are clickable. */
function linkify(text: string, keyBase: string): ReactNode[] {
  const parts = text.split(/(https?:\/\/[^\s<>()]+)/g);
  return parts.map((p, i) =>
    /^https?:\/\//.test(p) ? (
      <a key={`${keyBase}-l${i}`} href={p} target="_blank" rel="noreferrer noopener">{p}</a>
    ) : (
      <span key={`${keyBase}-l${i}`}>{p}</span>
    ),
  );
}

function inlineNodes(text: string, keyBase: string): ReactNode[] {
  const pattern = /(`[^`]+`)|(!\[[^\]]*\]\([^)\s]+\))|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(\*[^*]+\*)|(_[^_\n]+_)/g;
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push(<span key={`${keyBase}-t${n++}`}>{linkify(text.slice(last, m.index), `${keyBase}-t${n}`)}</span>);
    const tok = m[0]!;
    const key = `${keyBase}-${n++}`;
    if (tok.startsWith("`")) {
      out.push(<code key={key} className="md-inline-code">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("![")) {
      const alt = /^!\[([^\]]*)\]/.exec(tok)?.[1] ?? "";
      const src = /\]\(([^)]+)\)$/.exec(tok)?.[1] ?? "";
      out.push(safeUrl(src) ? <img key={key} src={src} alt={alt} loading="lazy" /> : <span key={key}>{alt}</span>);
    } else if (tok.startsWith("[")) {
      const label = /^\[([^\]]+)\]/.exec(tok)?.[1] ?? tok;
      const href = /\]\(([^)]+)\)$/.exec(tok)?.[1] ?? "";
      out.push(safeUrl(href) ? <a key={key} href={href} target="_blank" rel="noreferrer noopener">{label}</a> : <span key={key}>{label}</span>);
    } else if (tok.startsWith("**")) {
      out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("~~")) {
      out.push(<del key={key}>{tok.slice(2, -2)}</del>);
    } else {
      out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(<span key={`${keyBase}-t${n++}`}>{linkify(text.slice(last), `${keyBase}-t${n}`)}</span>);
  return out;
}

interface ListItem { indent: number; ordered: boolean; text: string; checked?: boolean }

function buildList(items: ListItem[], keyBase: string): ReactNode {
  if (items.length === 0) return null;
  const Tag = items[0]!.ordered ? "ol" : "ul";
  const nodes: ReactNode[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i]!;
    const base = item.indent;
    const children: ListItem[] = [];
    let j = i + 1;
    while (j < items.length && items[j]!.indent > base) {
      children.push(items[j]!);
      j++;
    }
    nodes.push(
      <li key={`${keyBase}-i${i}`}>
        {item.checked !== undefined && (
          <input className="md-task-box" type="checkbox" checked={item.checked} readOnly tabIndex={-1} aria-hidden="true" />
        )}
        {inlineNodes(item.text, `${keyBase}-i${i}`)}
        {children.length > 0 && <div className="md-nest">{buildList(children, `${keyBase}-i${i}n`)}</div>}
      </li>,
    );
    i = j;
  }
  return <Tag key={`${keyBase}-list`}>{nodes}</Tag>;
}

function buildTable(rows: string[][], aligns: string[], keyBase: string): ReactNode {
  const [head, ...body] = rows;
  const align = (i: number) => ({ textAlign: (aligns[i] ?? "left") as "left" | "center" | "right" });
  return (
    <table key={keyBase} className="md-table">
      <thead>
        <tr>
          {(head ?? []).map((cell, i) => (
            <th key={i} style={align(i)}>{inlineNodes(cell, `${keyBase}-h${i}`)}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((row, ri) => (
          <tr key={ri}>
            {row.map((cell, ci) => (
              <td key={ci} style={align(ci)}>{inlineNodes(cell, `${keyBase}-${ri}-${ci}`)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Safe markdown renderer (React elements only — never dangerouslySetInnerHTML).
 * Blocks: fenced code (highlighted + copy), headings, hr, blockquotes, GFM
 * tables, ordered/unordered/nested/task lists, paragraphs with `<br>` on
 * double-space. Inline: links, images, bold, italic, strikethrough, code and
 * bare-URL linkifying.
 */
export function Markdown({ text, caret = false }: { text: string; caret?: boolean }) {
  const t = decodeEntities(text);
  const lines = t.split(/\r?\n/);
  const out: ReactNode[] = [];
  let key = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // fenced code
    if (/^\s*```/.test(line)) {
      const lang = line.trim().replace(/^```/, "").trim().split(/\s+/)[0] ?? "";
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? "")) {
        buf.push(lines[i] ?? "");
        i++;
      }
      i++; // closing fence (or EOF)
      out.push(<CodeBlock key={`cb${key++}`} code={buf.join("\n")} lang={lang} />);
      continue;
    }

    // horizontal rule
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      out.push(<hr key={`hr${key++}`} />);
      i++;
      continue;
    }

    // blockquote
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? "")) {
        buf.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(<blockquote key={`bq${key++}`} className="md-quote">{inlineNodes(buf.join(" "), `bq${key}`)}</blockquote>);
      continue;
    }

    // table
    if (line.includes("|") && (lines[i + 1] ?? "").includes("-") && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? "")) {
      const splitRow = (r: string) => r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1] ?? "").map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"));
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== "") {
        body.push(splitRow(lines[i] ?? ""));
        i++;
      }
      out.push(buildTable([header, ...body], aligns, `tb${key++}`));
      continue;
    }

    // lists (ordered / unordered / nested / task)
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const items: ListItem[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i] ?? "")) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i] ?? "")!;
        const indent = Math.floor((m[1] ?? "").replace(/\t/g, "  ").length / 2);
        const ordered = /^\d/.test(m[2] ?? "");
        let bodyText = m[3] ?? "";
        let checked: boolean | undefined;
        const task = /^\[( |x|X)\]\s*(.*)$/.exec(bodyText);
        if (task) {
          checked = task[1] !== " ";
          bodyText = task[2] ?? "";
        }
        items.push({ indent, ordered, text: bodyText, checked });
        i++;
      }
      out.push(buildList(items, `ls${key++}`));
      continue;
    }

    // headings
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = (heading[1] ?? "#").length;
      const content = inlineNodes(heading[2] ?? "", `h${key}`);
      if (level === 1) out.push(<h2 key={`h${key++}`}>{content}</h2>);
      else if (level === 2) out.push(<h3 key={`h${key++}`}>{content}</h3>);
      else if (level === 3) out.push(<h4 key={`h${key++}`}>{content}</h4>);
      else out.push(<h5 key={`h${key++}`}>{content}</h5>);
      i++;
      continue;
    }

    // blank line
    if (line.trim() === "") {
      out.push(<div key={`g${key++}`} className="md-gap" />);
      i++;
      continue;
    }

    // paragraph (consecutive plain lines; two trailing spaces = hard break)
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^\s*```/.test(lines[i] ?? "") &&
      !/^\s*>/.test(lines[i] ?? "") &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i] ?? "") &&
      !/^#{1,6}\s/.test(lines[i] ?? "") &&
      !/^\s*(---|\*\*\*|___)\s*$/.test(lines[i] ?? "")
    ) {
      para.push(lines[i] ?? "");
      i++;
    }
    const nodes: ReactNode[] = [];
    para.forEach((raw, idx) => {
      const hardBreak = /\s{2,}$/.test(raw);
      nodes.push(<span key={`pl${idx}`}>{inlineNodes(raw.trimEnd(), `p${key}-${idx}`)}</span>);
      if (idx < para.length - 1) nodes.push(hardBreak ? <br key={`br${idx}`} /> : <span key={`sp${idx}`}> </span>);
    });
    out.push(<p key={`p${key++}`}>{nodes}</p>);
  }

  return (
    <div className="markdown" dir="auto">
      {out}
      {caret && <span className="md-caret" aria-hidden="true" />}
    </div>
  );
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
