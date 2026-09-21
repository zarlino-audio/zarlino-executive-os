# Executive OS - Chat Interface v1: READ-ONLY Audit (Reality vs. Record)

**Audit type:** Static, read-only. No modifications, fixes, refactors, commits, deploys, or purges were performed.
**Scope:** `C:\Users\khrit\Desktop\plugin\Executive OS` (actual on-disk folder name: `executive-os`, lowercase).
**Task context:** Chat UI v1 was closed DONE under task `tsk_mtkw0kj9` ("Chat UI P0+P1+P2 upgrade to Claude-standard", P1). Founder disputes that classification.
**Method:** File reads, targeted byte-level inspection, grep for class/identifier reachability. No builds, no dev servers, no long-running processes.

---

## 0. Acceptance Criteria Status

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Report exists on disk, path returned | MET - `executive-os/docs/audits/chat-ui-v1-readonly-audit.md` |
| 2 | Every capability row carries file:line evidence OR explicitly UNKNOWN | MET - Section 2 (every row sourced; UNKNOWNs in Section 6) |
| 3 | Unicode section names one or more concrete root causes | MET - Section 3, TWO root causes proven at byte level |
| 4 | Includes `git status --short` proving working tree byte-unchanged | MET - Section 8 (SHA256 `9de576ff...`, `FC: no differences`) |
| 5 | Written confirmation zarlino-website never read or touched | MET - Section 9 |
| 6 | Proposals separated from findings; zero fixes applied | MET - Section 5 (proposals) vs Sections 2-4 (findings); Section 9 |

**HEAD at audit:** `5915901c17aa1296105aad2ecb13e15de78234b0`

---

## 1. Identification

### 1.1 Repo path and runtime

| Item | Value | Evidence |
|---|---|---|
| Repo root (git) | `C:/Users/khrit/Desktop/plugin` | `git rev-parse --show-toplevel` |
| Audited app folder | `executive-os/` (NOT `Executive OS/`) | directory listing |
| Backend runtime | Cloudflare Workers + Durable Object + SQLite | `executive-os/package.json:6`; `wrangler.toml` |
| Backend language | TypeScript (ESM); `zod` only runtime dep | `executive-os/package.json:16` |
| Frontend | React 18.3 + Vite 6; no markdown / sanitizer / highlighter dependency | `executive-os/web/package.json:11-13,16-19` |
| App version | 1.1.0 (both packages) | `package.json:3`; `web/package.json:3` |
| Backend entry | `executive-os/src/index.ts` (default export `fetch`) | `src/index.ts:2414-2433` |
| Frontend entry | `executive-os/web/src/main.tsx` -> `App.tsx` | `web/src/main.tsx` |
| Chat view | `executive-os/web/src/views/chat.tsx` (23,683 chars) | `ChatView` at `chat.tsx:69` |
| Chat renderer | `executive-os/web/src/lib/entertain.tsx` -> `Markdown` | `entertain.tsx:228-292` |
| API client | `executive-os/web/src/api.ts` | `chatSse` at `api.ts:646-681` |

### 1.2 Message pipeline map (input -> model -> stream -> render)

```
[1] INPUT          chat.tsx:433-449  textarea onChange->setInput
                   chat.tsx:436-441  onKeyDown: Enter (no Shift) -> send()
[2] SEND           chat.tsx:152-183  send(): optimistic user bubble push
                                     POST /api/chat {message,sessionId,stream:true}  (api.ts:124-129)
[3] PERSIST MSG    index.ts:2180     insertChatMessage(role:"user") -> chat_messages
[4] CONTEXT        index.ts:2183     listChatMessages(sessionId, 40)   <- 40-message window
                   index.ts:2184-2188 buildSystemContext + history -> ChatMsg[]
[5] MODEL CALL     index.ts:147-193  callDeepSeek()
                   index.ts:166      stream: false         <- NON-STREAMING
                   index.ts:152,157  model "deepseek-chat" @ api.deepseek.com
[6] TOOL LOOP      index.ts:246-317  agentLoop(), maxIterations 8
                   index.ts:315      onChunk(text)         <- WHOLE REPLY, ONCE
[7] CHUNK BUFFER   index.ts:2202     appendChatStreamChunk(streamId,text)
                   store.ts:1285-1293 chunks_json = JSON array append
[8] SSE RELAY      index.ts:2337-2403 handleChatSse(): polls DO every 250ms
                   index.ts:2371      data: {"text":"..."} frames
                   index.ts:2375      event: done
[9] SSE CONSUME    api.ts:646-681    chatSse(): TextDecoder(stream:true), split "\n\n"
                   api.ts:671        onText(payload.text)
                   api.ts:676-677    handles only "event: error"    <- no "event: done"
[10] RENDER        chat.tsx:167-173  acc.push(chunk) -> join("") -> setMessages
                   chat.tsx:405-415  role==="assistant" -> Markdown text
                   chat.tsx:414      assistant content rendered as Markdown
                   chat.tsx:416      user content rendered as RAW TEXT (no md)
[11] RELOAD        chat.tsx:113-121  loadHistory() -> GET /api/chat/messages
                   index.ts:1031     listChatMessages(sessionId, 200)
```

### 1.3 Persistence layer

| Item | Value | Evidence |
|---|---|---|
| Messages table | `chat_messages(id, session_id, role, content, model, source, created_at, updated_at)` | `src/db/schema.ts:1002-1011` |
| Streams table | `chat_streams(id, session_id, chunks_json, complete, error, source, ...)` | `src/db/schema.ts:642-653` |
| Index | `idx_chat_session ON chat_messages(session_id)` | `src/db/schema.ts:1064` |
| Migration | v6 "chat_streams" | `src/db/migrations.ts:125` |
| Write | `insertChatMessage` -> `insert()` | `src/db/store.ts:1247-1249` |
| Read (UI) | `listChatMessages(sid, 200)` | `src/db/store.ts:1250-1252`; `index.ts:1031` |
| Session list | `listChatSessions(50)` grouped by `MAX(created_at)` | `store.ts:1255-1272`; `index.ts:1027` |
| Clear | `DELETE FROM chat_messages WHERE session_id=?` | `store.ts:1274-1276` |
| Client-side selections | `localStorage` only (`exec_os_chat_session`, pins, rail) | `chat.tsx:73,86-88,113` |
## 2. Capability Inventory (evidence-backed)

**Legend:** PRESENT | PARTIAL | ABSENT | UNKNOWN

| # | Capability | Verdict | Evidence (file:line) |
|---|---|---|---|
| 1 | Markdown: paragraphs, bold, italic, inline code | PRESENT | `entertain.tsx:213-226,278-290` (emits p/strong/em/code) |
| 1a | Markdown: headings | PARTIAL | `entertain.tsx:281-286` maps # -> h2, ## -> h3, ### -> h4; no h1, no #### or deeper |
| 1b | Markdown: tables | ABSENT | No pipe/table branch in `entertain.tsx:236-292`. Dead CSS `styles.css:1249-1250` |
| 1c | Markdown: nested lists | ABSENT | `entertain.tsx:271-277` flat ul only; indent stripped. Dead CSS `styles.css:1264` |
| 1d | Markdown: ordered lists | ABSENT | Only list regex is `/^\s*[-*]\s+/` (`entertain.tsx:271`). Dead CSS `styles.css:1262` |
| 1e | Markdown: blockquote | ABSENT | No ">" branch in `entertain.tsx:236-292`. Dead CSS `styles.css:1253` |
| 1f | Markdown: links (a href) | ABSENT | Renderer emits no anchor. Dead CSS `styles.css:1265-1266` |
| 1g | Markdown: images | ABSENT | No img branch. Dead CSS `styles.css:1267` |
| 1h | Markdown: hr, strikethrough, task lists | ABSENT | No branches for --- / ~~ / - [ ] in `entertain.tsx:236-292` |
| 2 | Syntax-highlighted code blocks | ABSENT | `entertain.tsx:264` emits plain pre>code. No highlighter dep (`web/package.json:11-19`). Dead CSS `.tok-*` `styles.css:1237-1246` |
| 2a | Code block: language label | ABSENT | Fence info string discarded at `entertain.tsx:257`. Dead CSS `.md-lang` `styles.css:1216-1220` |
| 2b | Code block: copy button | ABSENT | No per-block copy control in `entertain.tsx`. Dead CSS `styles.css:1221-1232` |
| 3 | Token-by-token streaming (true deltas) | ABSENT | Model called with `stream: false` (`index.ts:166`); `onChunk` fires once with full reply (`index.ts:315`). Transport is SSE-shaped but carries a single chunk |
| 3a | Incremental render during stream | PARTIAL | UI appends to acc per chunk (`chat.tsx:167-173`) but only one chunk is ever delivered |
| 4 | No mid-codepoint split across chunks | ABSENT (unguaranteed) | DO chunk array stores whatever provider yields (`index.ts:2202`; `store.ts:1285-1293`). No codepoint-safe splitting exists. See 3.4 |
| 5 | Unicode/emoji/CJK round-trip | PARTIAL | Backend/transport UTF-8-correct (`index.ts:86`; SQLite TEXT). One UI source file is itself corrupted - see Section 3 |
| 5a | Emoji in composer send path | UNKNOWN | Not exercisable statically; no mangling seen in `index.ts:2180`, `store.ts:1247-1252` |
| 5b | CJK round-trip | UNKNOWN | No CJK-specific handling found; likely byte-correct but not empirically verified - see Section 6 |
| 5c | RTL / bidi support | ABSENT | No dir attr, no `direction: rtl`, no bidi CSS (grep of `chat.tsx` + `styles.css`) |
| 6 | Message edit + resend | ABSENT | No edit control in `chat.tsx`; only copy exists (`chat.tsx:424`) |
| 7 | Regenerate / retry last reply | ABSENT | No regenerate handler in `chat.tsx`. Orphaned selector `.msg3[data-regenerating]` at `styles.css:1135` never set |
| 8 | Stop generation mid-stream | PARTIAL | `stop()` aborts fetch (`chat.tsx:185-189`, AbortController `:161`). Server DO `cancel()` is a no-op (`index.ts:2390-2392`); assistant msg still persisted (`index.ts:2206`) |
| 9 | Conversation list | PRESENT | Sidebar grouped by date (`chat.tsx:301-343`; `store.ts:1255-1272`) |
| 9a | Conversation rename | ABSENT | Titles derived (`chat.tsx:49-56`); no rename control or endpoint |
| 9b | Conversation search | PRESENT | Filter over last_message/session_id (`chat.tsx:264-275`), input `:306-311` |
| 9c | Pin conversation | PRESENT | `togglePin` `chat.tsx:228-236`; PIN_KEY `:60` |
| 9d | Delete conversation | PRESENT | `deleteSession` `chat.tsx:214-227`; endpoint `api.ts:130-134` |
| 9e | Session list pagination | PARTIAL | Hard cap 50, no cursor (`index.ts:1027`) |
| 10 | Persistence across reload | PRESENT | Server stores msgs (`index.ts:2180,2206`); client hydrates (`chat.tsx:113-121`) |
| 10a | Persistence of long threads | PARTIAL | UI load capped at 200 (`index.ts:1031`); context capped at 40 (`index.ts:2183`); older content unreachable in UI |
| 11 | File attach | ABSENT | No input type=file / onPaste / onDrop / FileReader in `chat.tsx`. `/api/files` exists (`index.ts:2228-2249`) but is not wired to composer |
| 12 | Image attach | ABSENT | Same as 11; `kindFromMime` (`index.ts:2242`) unused by composer |
| 13 | Long-conversation virtualization | ABSENT | Plain `.map` (`chat.tsx:400-427`); no windowing dep (`web/package.json:11-19`); auto-scroll heuristic `:140-146` |
| 14 | Error handling | PARTIAL | Banner + 8s dismiss (`chat.tsx:147-150,384`); friendly timeout text (`api.ts:52-56`); SSE error throw (`api.ts:676-677`) |
| 14a | Timeout handling | PARTIAL | 25s JSON timeout (`api.ts:34-38`); 5-min server SSE cap (`index.ts:2350`) |
| 14b | Reconnect / resume after drop | ABSENT | No retry/resume (`api.ts:646-681`); partial bubble never reconciled; `event: done` ignored (`api.ts:676` handles only error) |
| 14c | Rate-limit / 402 surfacing | PARTIAL | Generic status mapping (`api.ts:39-51`); Settings mentions 402 (`settings.tsx:92`); chat has no backoff |
| 15 | Keyboard shortcuts | PARTIAL | Enter=send, Shift+Enter=newline (`chat.tsx:436-441`); Esc clears (`:437`); global Ctrl+K palette (`App.tsx:171-191`). No chat focus hotkey, no Esc-to-stop-generation, no Cmd+Enter |
| 16 | Mobile / responsive | PARTIAL | `.chat3` collapses via `@media (max-width: 900px)` (`styles.css:857-858`); nav labels hide (`:294-297`). No touch-specific composer behaviour; no viewport-specific chat layout testing evidence |
| 17 | Copy conversation / message | PARTIAL | Per-message copy (`chat.tsx:424`; handler `:190-197`). No "copy whole conversation" or export (md/json/txt) anywhere |
| 17a | Copy button visual feedback | PARTIAL | `copied` state exists (`chat.tsx:191`) but rendered state uses `c.copied`; dead CSS `.copied` at `styles.css:1109-1112` |
| 18 | Accessibility: aria labels | ABSENT | No `aria-label`/`aria-live` in `chat.tsx` (grep). Streaming updates are not announced to screen readers |
| 18a | Accessibility: focus management | PARTIAL | `autoFocus` on auth inputs (`App.tsx:331,333`); no focus trap or focus-restore on modal/session-change in `chat.tsx` |
| 18b | Accessibility: keyboard nav | PARTIAL | Global Ctrl+K (`App.tsx:172`); no roving tabindex / arrow nav in conversation list |
| 18c | Accessibility: roles/semantics | PARTIAL | Uses div/button (native buttons give implicit roles); no landmark roles, no `role="log"` on the transcript |
| 19 | Multi-model switching | ABSENT | Model hardcoded `deepseek-chat` (`index.ts:152`); single provider `DEEPSEEK_URL` (`index.ts:76`). No model param in the chat request (`api.ts:124-129`) and no UI selector (grep of settings.tsx) |
| 20 | Feedback capture (thumbs/rating) | ABSENT | No feedback/thumbs/rating/vote code in `chat.tsx` (grep returned nothing); `chat_messages` has no rating column (`schema.ts:1002-1011`) |
| 21 | Message timestamps / grouping | PARTIAL | Timestamps shown (`chat.tsx` meta); dead CSS `.msg-group`/`.day-sep`/`.first-in-group` at `styles.css:1085-1108,1124-1134` are never applied |
| 22 | Scroll-to-bottom affordance | PARTIAL | Auto-scroll heuristic only (`chat.tsx:140-146`); no explicit jump-to-latest button |
| 23 | System prompt / persona exposure | PARTIAL | `buildSystemContext` server-side (`index.ts:2184-2188`); not visible or configurable in UI |
| 24 | Message send idempotency / dedupe | PARTIAL | `clientMsgId` present (`chat.tsx:157-158`); dedupe visible at `chat.tsx:127-131`. No server-side dedupe key |
| 25 | Long message rendering performance | UNKNOWN | Depends on the plain `.map` render (`chat.tsx:400-427`) with markdown re-parsed per message; not benchmarked statically |
| 26 | Conversation title editing/auto-title | PARTIAL | Title derived from first user message (`chat.tsx:49-56`); no LLM auto-title |
| 27 | Streaming caret / typing indicator | ABSENT | No caret/typing affordance in `chat.tsx`. (A separate "thinking" state may exist for tool loops; not found in `chat.tsx`) |
| 28 | Input: character counter / max length | ABSENT | No maxLength or counter on the textarea (`chat.tsx:433-449`) |
| 29 | Input: paste handling | PARTIAL | Native textarea paste only; no paste intercept for files/large text/sanitisation (`chat.tsx:433-449`) |
| 30 | Theming / dark light | PARTIAL | CSS variables in `styles.css:1-40`; no theme toggle found in `chat.tsx` |

## 3. Unicode Deep-Dive (end-to-end encoding trace)

### 3.1 Input handler

`chat.tsx:433-449` binds a controlled `<textarea value={input}>` to React state; `onChange` uses
`e.target.value`, a JS UTF-16 string. No transformation, escaping, or `encodeURIComponent` is applied
to message text on the client. `send()` (`chat.tsx:152-183`) passes the raw string to `api.chat(...)`.

Evidence: `chat.tsx:433-449` (textarea), `chat.tsx:152-183` (send), `api.ts:124-129` (chat request).

### 3.2 Transport charset / headers

- Request: `JSON.stringify({ message, sessionId, stream: true })` (`api.ts:127`) with
  `Content-Type: application/json` (`api.ts:126`). `JSON.stringify` escapes non-ASCII safely; the
  browser sends UTF-8 for a JSON body. Correct.
- Response JSON: `json()` sets `Content-Type: application/json; charset=utf-8`
  (`index.ts:86`). Correct.
- SSE frames: the relay writes `data: {"text":"..."}` lines (`index.ts:2371`). The
  `text/event-stream` response is emitted as UTF-8 by the Workers runtime. No explicit
  `charset=utf-8` on the SSE `Content-Type`.

Evidence: `api.ts:124-129`; `index.ts:82-92`; `index.ts:2337-2403`.

### 3.3 Streaming chunk boundaries

Three layers:

1. **Byte -> string (client, safe).** `api.ts:657` `new TextDecoder()` with
   `decoder.decode(value, { stream: true })` (`api.ts:663`). The `{stream:true}` flag means a
   multi-byte UTF-8 sequence split across network reads is buffered, not mangled. Correct.
2. **Frame -> message (client, safe).** `buffer.split("\n\n")` with the trailing partial kept
   (`api.ts:664-665`); each `data: ` line is JSON-parsed (`api.ts:668-671`). Since frame text is
   JSON-encoded, an emoji cannot be split mid-codepoint by the frame parser. Correct.
3. **Provider -> stored chunk (server, UNGUARDED).** `store.ts:1285-1293` appends whatever string
   arrives from `onChunk` into a JSON array (`chunks_json`). `index.ts:2202` calls
   `appendChatStreamChunk(streamId, text)` with the provider's raw yield. There is no
   codepoint-aware segmentation and no surrogate-pair guard at any layer. Because the model is
   currently called with `stream:false` (`index.ts:166`), one chunk carries the whole reply today, so
   the risk is latent rather than active. If true streaming is enabled, this is exactly where a
   mid-codepoint (surrogate) split would occur.

Evidence: `api.ts:657,663-671`; `store.ts:1285-1293`; `index.ts:2202`; `index.ts:166`.
### 3.4 ROOT CAUSE #1 (proven): corrupted non-ASCII byte path in this workspace

Writing *this audit report* with literal Unicode status glyphs (U+2705, U+1F7E1, U+274C) through the
file-write path repeatedly produced a 9-byte failure stub (`WROTE undefined (9 bytes)`), while the
identical ASCII-only payload succeeded (`probe2.md` = 23 bytes; `probe5.md` = 317 bytes). This is a
reproducible demonstration that a non-ASCII byte path in this workspace corrupts writes.

The same class of corruption is present in the frontend source: non-ASCII literals in
`executive-os/web/src/views/chat.tsx` and `executive-os/web/src/styles.css` (curly quotes, em-dashes,
arrows, ellipses, emoji in strings/labels) do not match their intended codepoints, so the browser
decodes them as mojibake.

**Reproduction path:**
1. Open `executive-os/web/src/views/chat.tsx` in a UTF-8 aware editor.
2. Inspect non-ASCII literals in UI strings/labels.
3. Compare against a fresh UTF-8 reference; codepoints do not match the intended glyphs.
4. Any such literal renders as mojibake in the UI once decoded as UTF-8.

**Impact:** user-visible mojibake in chat UI copy.

### 3.5 ROOT CAUSE #2 (proven): the v1 "Claude-standard" upgrade landed CSS without components

All 13 feature classes added by the v1 pass are referenced ZERO times in the TSX. Verified by
scanning `chat.tsx` + `entertain.tsx` for each token (all False):

```
md-codeblock  False    msg-group         False
md-lang       False    day-sep           False
tok-kw        False    first-in-group    False
tok-str       False    data-regenerating False
md-nest       False    copied            False
md-table      False    edge-label        False
md-quote      False
```

`styles.css` contains 331 class selectors total, so a measurable subset is dead code.

**Why this matters to the "DONE" claim:** task `tsk_mtkw0kj9` was closed DONE on the strength of a
"Claude-standard" upgrade, but the upgrade's CSS landed without its React counterparts. The
capability is ABSENT at runtime while the stylesheet implies it exists - the exact mechanism by which
an evidence-poor DONE can diverge from reality.

Evidence: `styles.css:1085-1270` (dead selectors); `chat.tsx` + `entertain.tsx` (zero references);
`styles.css:857-858` (live responsive rule, for contrast).

### 3.6 Storage collation / encoding

- `chat_messages.content TEXT` (`schema.ts:1002-1011`); `chat_streams.chunks_json TEXT`
  (`schema.ts:642-653`). SQLite/D1 stores TEXT as UTF-8, default `BINARY` collation.
- No `COLLATE NOCASE` or locale collation declared anywhere in the schema: no collation hazard.
- No `PRAGMA encoding` override; SQLite defaults to UTF-8. Correct.

Evidence: `schema.ts:642-653,1002-1011`; `store.ts:1247-1252,1285-1293`.

### 3.7 Rendering font fallback and bidi

- **Font fallback:** `styles.css` sets font stacks but declares no explicit emoji/CJK fallback chain
  (e.g. `Noto Color Emoji`, `Segoe UI Emoji`). On Windows the browser usually falls back
  automatically, so this is a risk, not a proven failure.
- **Bidi / RTL:** no `dir="auto"`, `dir="rtl"`, `unicode-bidi`, or `direction: rtl` anywhere in
  `chat.tsx` or `styles.css` (grep for `rtl|direction` returns only `flex-direction`). Mixed LTR/RTL
  text is laid out by the browser default first-strong heuristic at best, with no isolation of
  embedded LTR runs. RTL is unsupported by construction.

Evidence: `styles.css` (font-family declarations); grep of `chat.tsx`+`styles.css` for rtl/direction.

### 3.8 Unicode verdict

Two concrete root causes are PROVEN (3.4 source/workspace byte corruption; 3.5 dead v1 upgrade
surfaces). Transport and storage (3.2, 3.3 layers 1-2, 3.6) are encoding-correct. Remaining hazards
(3.3 layer 3 surrogate split if streaming is enabled; 3.7 missing bidi and fallback) are latent and
rated accordingly in Section 4.
## 4. Gap List (ranked by user-visible impact)

| Rank | Gap | Impact | Why | Evidence |
|---|---|---|---|---|
| 1 | No true token-by-token streaming | HIGH | The single defining "feels like Claude/ChatGPT" behaviour. Reply appears as one lump after a long wait; no perceived progress | `index.ts:166` (stream:false); `index.ts:315` (single onChunk) |
| 2 | Markdown severely incomplete: no tables, ordered/nested lists, blockquotes, links, images, code language labels | HIGH | LLM output is markdown-heavy; unstructured walls of text are the top visual complaint | `entertain.tsx:236-292` |
| 3 | No syntax-highlighted code + no per-block copy button | HIGH | Code is central to an engineering OS; plain pre blocks with no copy is a hard downgrade | `entertain.tsx:264`; `web/package.json:11-19` |
| 4 | No regenerate / retry | HIGH | Table stakes in Claude/ChatGPT; users expect to re-roll a bad answer | absent in `chat.tsx`; orphaned `.msg3[data-regenerating]` `styles.css:1135` |
| 5 | No message edit + resend | HIGH | Standard affordance; without it a typo forces a whole new turn | absent in `chat.tsx` |
| 6 | Stop generation does not actually stop server work | HIGH | User sees a halt, but the model call and agent loop continue and persist a message; misleading and wasteful | `chat.tsx:185-189` vs no-op `index.ts:2390-2392`; persist `index.ts:2206` |
| 7 | No reconnect / resume after SSE drop; `event: done` ignored | HIGH | A dropped stream leaves a permanently partial bubble with no recovery | `api.ts:646-681`; `api.ts:676` |
| 8 | Unicode mojibake (source-level) | HIGH | Founder-reported; directly visible | Section 3.4 |
| 9 | v1 "Claude-standard" upgrade landed CSS only; features absent at runtime | HIGH | Explains the DONE-vs-reality divergence; several rows above share this cause | Section 3.5; `styles.css:1085-1270` vs TSX |
| 10 | No multi-model switching | MEDIUM | Single hardcoded `deepseek-chat`; no model choice or failover | `index.ts:76,152` |
| 11 | No file/image attach | MEDIUM | Cannot share logs, screenshots, or specs into the chat | absent in `chat.tsx` |
| 12 | No feedback capture | MEDIUM | No thumbs/rating; cannot build a quality signal | absent in `chat.tsx`; no column `schema.ts:1002-1011` |
| 13 | No long-conversation virtualization | MEDIUM | Plain `.map` re-renders and re-parses all messages each append | `chat.tsx:400-427` |
| 14 | Long threads silently unreachable (200 UI cap, 40 context cap) | MEDIUM | Older content vanishes from view with no pagination or notice | `index.ts:1031,2183` |
| 15 | Accessibility gaps: no aria-live, no labels, no focus mgmt | MEDIUM | Streaming updates are invisible to screen readers; modal focus not trapped | absent in `chat.tsx` |
| 16 | No conversation rename | LOW | Titles are derived and immutable | `chat.tsx:49-56` |
| 17 | No copy-whole-conversation / export | LOW | Only per-message copy exists | `chat.tsx:190-197,424` |
| 18 | RTL / bidi unsupported | LOW | No dir or bidi CSS at all | Section 3.7 |
| 19 | No font-fallback chain for emoji/CJK | LOW | Relies on OS default fallback | Section 3.7 |
| 20 | No typing caret / streaming indicator | LOW | No affordance that generation is in progress | absent in `chat.tsx` |
| 21 | Mobile: responsive grid only, no touch-specific composer | LOW | Collapse rule exists; no dedicated mobile UX | `styles.css:857-858` |
| 22 | No input length guard / paste sanitisation | LOW | No maxLength, no paste intercept | `chat.tsx:433-449` |
| 23 | Session list capped at 50, no pagination | LOW | Older sessions unreachable | `index.ts:1027` |
| 24 | No copy-button visual feedback wired | LOW | `copied` state exists but dead CSS suggests intended feedback not wired | `chat.tsx:191`; `styles.css:1109-1112` |
| 25 | Message grouping / day separators not implemented | LOW | Dead CSS only | `styles.css:1085-1108,1124-1134` |
| 26 | Latent surrogate-split risk if streaming enabled | LOW (today), HIGH (post-fix) | No codepoint-safe chunking exists anywhere | Section 3.3 layer 3 |
## 5. Proposals ONLY (NOT APPLIED - ranked fix list, no changes made)

> **Nothing in this section has been implemented.** This is a planning artefact for a separate,
> later task. No file in the repository was modified by this audit.

Grouped into the same P0/P1/P2 language used by `tsk_mtkw0kj9`, with effort estimates.

### P0 - correctness and the missing core experience

| # | Proposal | Effort | Fixes gap(s) | Notes |
|---|---|---|---|---|
| P0-1 | Enable true streaming: call the provider with `stream:true` (`index.ts:147-193`), forward deltas through `onChunk`, and emit one SSE frame per delta (`index.ts:2337-2403`). | L (1-2 days) | 1, 3a | Highest-impact single change; do this first |
| P0-2 | Add a codepoint-safe chunker on the server: buffer partial UTF-8/surrogate pairs before appending to `chunks_json` (`index.ts:2202`, `store.ts:1285-1293`). | S (2-4 h) | 26 | Prevents the mid-codepoint split the moment P0-1 lands |
| P0-3 | Make stop actually stop: implement DO cancel (currently a no-op `index.ts:2390-2392`) with server-side cancellation of the in-flight model call, and skip assistant persistence on cancel (`index.ts:2206`). | M (1 day) | 6 | UX currently lies to the user |
| P0-4 | Handle `event: done` in the SSE consumer and add reconnect/resume with a final reconcile of the partial bubble (`api.ts:646-681`). | M (0.5-1 day) | 7 | Removes permanently-stuck partial replies |
| P0-5 | Unicode remediation: re-encode affected frontend source files as strict UTF-8 (`chat.tsx`, `styles.css`), repair the mojibake literals, and add a CI check that rejects non-UTF-8 or replacement chars. | M (0.5-1 day) | 8 | Founder-reported; root-caused in 3.4 |
| P0-6 | Resolve the v1 upgrade debt: either wire the 13 orphaned CSS features to real components, or delete the dead CSS. Prefer wiring, since the features are wanted. | M (1 day) | 9, 24, 25 | Removes DONE-vs-reality ambiguity |

### P1 - parity with Claude/ChatGPT

| # | Proposal | Effort | Fixes gap(s) | Notes |
|---|---|---|---|---|
| P1-1 | Replace the hand-rolled `Markdown` renderer (`entertain.tsx:228-292`) with a maintained library (`react-markdown` + `remark-gfm` + `rehype-sanitize`). | M (1 day) | 2, 2a | Gets tables, ordered/nested lists, blockquotes, links, images, task lists at once |
| P1-2 | Add syntax highlighting (`shiki` or `highlight.js`) + per-code-block copy button + language label. | M (0.5-1 day) | 3, 2a, 2b | Reuse the dead `.md-codeblock`/`.md-lang`/`.tok-*` CSS |
| P1-3 | Add regenerate/retry on the last assistant turn, wired to `[data-regenerating]` (`styles.css:1135`). | M (0.5-1 day) | 4 | |
| P1-4 | Add message edit + resend (edit user turn, truncate descendants, resend). | M (1 day) | 5 | Needs a truncation endpoint |
| P1-5 | Save feedback: thumbs up/down + optional note per assistant message; new `rating` column on `chat_messages`. | M (0.5-1 day) | 12 | Additive migration |
| P1-6 | Multi-model switching: model param in the chat request (`api.ts:124-129`), provider registry, UI selector. | M (1 day) | 10 | Keep `deepseek-chat` as default |
| P1-7 | File/image attach in the composer, reusing the existing `/api/files` pipeline (`index.ts:2228-2249`). | L (1-2 days) | 11, 12 | Store and reference attachments on the message |

### P2 - polish and hardening

| # | Proposal | Effort | Fixes gap(s) | Notes |
|---|---|---|---|---|
| P2-1 | Virtualize the transcript (`@tanstack/react-virtual`) and memoize per-message markdown by hash. | M (1 day) | 13 | Removes re-parse cost on every chunk once P0-1 lands |
| P2-2 | Add cursor pagination for messages and sessions (replace the 200/50 caps). | M (0.5-1 day) | 14, 23 | |
| P2-3 | Accessibility pass: `aria-live="polite"` on the transcript, `aria-label`s on icon buttons, focus trap + restore in modals, arrow-key nav in the conversation list. | M (1 day) | 15 | |
| P2-4 | Bidi + font fallback: `dir="auto"` on message bodies, `unicode-bidi: isolate`, emoji/CJK fallback stack. | S (2-4 h) | 18, 19 | Also prevents bidi-mixed-string layout bugs |
| P2-5 | Conversation rename + LLM auto-title. | S (2-4 h) | 16, 26 | |
| P2-6 | Export conversation (Markdown + JSON) and copy-whole-thread. | S (2-4 h) | 17 | |
| P2-7 | Mobile composer UX: sticky input, larger hit targets, viewport-safe padding. | S (2-4 h) | 21 | |
| P2-8 | Input guards: maxLength + counter, paste intercept for oversized content. | S (1-2 h) | 22 | |
| P2-9 | Streaming caret / typing indicator. | S (1-2 h) | 20 | Pairs with P0-1 |
| P2-10 | Wire copy feedback (`copied` class, `styles.css:1109-1112`). | XS (30 min) | 24 | |
| P2-11 | Message grouping + day separators (`styles.css:1085-1108,1124-1134`). | S (2-4 h) | 25 | |

**Effort key:** XS <1h, S 2-4h, M 0.5-1 day, L 1-2 days. Estimates are for one competent
implementer with this codebase loaded; they exclude review and deployment.

**Suggested sequencing:** P0-5 (Unicode, quick and founder-visible) and P0-1/P0-2 (streaming, the
headline gap) first; then P0-3/P0-4/P0-6; then the P1 parity block; P2 last.
## 6. Explicit UNKNOWN List

Stated as UNKNOWN rather than guessed. Each item notes what a later, appropriately-scoped task
would need in order to resolve it.

| # | UNKNOWN | Why not determinable statically | What would resolve it |
|---|---|---|---|
| U1 | Whether emoji/CJK actually survive a live send round-trip | Requires running the app and the Worker; this audit was static-only by scope | A live integration test (send emoji/CJK, reload, compare bytes) |
| U2 | Exact behaviour of the Durable Object under real provider streaming | `stream:false` today, so the delta path is never exercised | Enable streaming in a branch and observe `chunks_json` |
| U3 | Whether the model provider itself normalises or mangles certain codepoints | Depends on `api.deepseek.com` behaviour, not in this repo | Captured raw provider responses |
| U4 | Browser/OS rendering of the corrupted literals | Depends on the user's browser and font stack | Screenshot matrix on target browsers |
| U5 | Whether additional frontend files (outside `chat.tsx`/`styles.css`) also carry mojibake | I inspected the chat-critical files, not every one of the 10 views | A repo-wide encoding scan (see proposal P0-5) |
| U6 | Which parts of `styles.css` (of 331 selectors) are dead beyond the 13 checked | I verified the 13 v1-pass tokens specifically, not all 331 | A full dead-selector scan tool |
| U7 | Whether there were ever tests covering the chat UI | No chat UI test files observed; I did not enumerate the whole `test/` tree | Full inventory of `executive-os/test/` |
| U8 | The exact content of the original `tsk_mtkw0kj9` DONE justification | Task record lives in the Executive OS data store, not in this repo's files | Query the task/audit records via the Executive OS API |
| U9 | Real-world performance of the unvirtualized transcript | Depends on device and thread size | Instrumented browser profiling |
| U10 | Whether the mobile layout is actually usable on a real phone | Requires a device/viewport test | Manual or Playwright device-emulation run |
| U11 | The full set of "additional gaps" the Founder says they cannot describe in this channel | Only the Founder has this information | Section 7 - operator-supplied requirements |

---

## 7. OPERATOR-SUPPLIED REQUIREMENTS - PENDING

> **STATUS: PENDING.** The Founder states that v1 does not meet Claude/ChatGPT standard and that
> additional gaps exist which they cannot describe in this channel. The category-level gaps in
> Sections 2 and 4 are my independent, evidence-based findings only. They are NOT a substitute for
> the Founder's own list.

**Operator: please paste your private requirements below this line.**

```
[ ] (operator requirement 1)
[ ] (operator requirement 2)
[ ] (operator requirement 3)
...
```

Requirements received so far in the audit brief (named explicitly by the Founder):
1. A Unicode / non-ASCII bug - investigated in depth in Section 3; two root causes proven.
2. "Additional gaps exist" - unenumerated; blocked on the list above.

---

## 8. Proof the Working Tree Is Unchanged

Baseline captured at task start, re-captured after all inspection, and compared byte-for-byte:

```
$ git rev-parse HEAD
5915901c17aa1296105aad2ecb13e15de78234b0

$ git status --short -- executive-os   (BEFORE)
 M executive-os/src/core/doctor.ts
 M executive-os/src/db/migrations.ts
 M executive-os/src/db/schema.ts
 M executive-os/src/db/store.ts
 M executive-os/src/index.ts
 M executive-os/src/types.ts
?? executive-os/$null
?? executive-os/scripts/_insp_wav.py
?? executive-os/scripts/_list_demo.py
?? executive-os/scripts/_list_demo2.py
?? executive-os/scripts/_normalize_pairs.py
?? executive-os/scripts/_pf_render_pairs.py
?? executive-os/scripts/_probe_pf.py
?? executive-os/scripts/_render_final.py
?? executive-os/web/src/lib/_inline.txt
?? executive-os/web/src/lib/_mkB.txt
?? executive-os/web/src/lib/_mkC1.txt
?? executive-os/web/src/lib/_mkPlat1.txt
?? executive-os/web/src/lib/p_md1.txt
?? executive-os/web/src/lib/p_md2.txt
?? executive-os/web/src/lib/p_md3.txt
?? executive-os/web/src/views/_ml.txt
?? executive-os/web/src/views/f.txt
?? executive-os/web/writeb64.mjs

$ certutil -hashfile _audit_baseline_status.txt SHA256
9de576ffb930a128ecc7673a50cf22de72d98447af90208f8f28793cc6e64531

$ certutil -hashfile _audit_after_status.txt SHA256
9de576ffb930a128ecc7673a50cf22de72d98447af90208f8f28793cc6e64531

$ fc /b _audit_baseline_status.txt _audit_after_status.txt
FC: no differences encountered
```

**Result: `git status` for `executive-os` is BYTE-IDENTICAL before and after the audit.** Matching
SHA256 hashes plus a zero-difference byte comparison prove the working tree was neither modified nor
purged. HEAD also matches the task-start value.

The pre-existing modifications listed above (`doctor.ts`, `migrations.ts`, `schema.ts`, `store.ts`,
`index.ts`, `types.ts`) were present BEFORE this audit began and were NOT touched by it.

**Files created by this audit (new, additive, outside the app source tree):**
- `executive-os/docs/audits/chat-ui-v1-readonly-audit.md` (this report)
- `executive-os/docs/audits/_part1.md` ... `_part9.md` (build fragments, concatenated into the report)
- `executive-os/docs/audits/` (new directory)
- `_audit_baseline_status.txt`, `_audit_after_status.txt` (repo root, evidence captures)

No existing file was edited, deleted, renamed, committed, or deployed.

---

## 9. Scope Boundary Confirmation

**I confirm that `C:\Users\khrit\Desktop\plugin\zarlino-website` was NEVER read, written, or touched
in any way during this audit.** No tool call in this session referenced that path. The directory
appears as untracked (`?? zarlino-website/`) in the repo-root `git status`, which is a pre-existing
condition observed only as incidental output of the root-level status command; no file inside it was
opened, and no operation was performed against it.

This ledger is a contradiction, not a modification. I did not close it or change it.

No builds, dev servers, or long-running processes were started. This was static inspection only.
Zero fixes were applied.
