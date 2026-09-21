# Chat Interface v2 — 26-Gap Closure Report

**Source audit:** `docs/audits/chat-ui-v1-readonly-audit.md` (Section 4, 26 ranked gaps)
**Status:** all 26 closed. Deployed as **Version `53ae8b95-b4ac-4355-81a7-1ea7abee4f6e`**, migration **v30 `chat_enhance`**.
**Verification:** `test/chat-ui.test.ts` (26 assertions, green) + live endpoint/stream checks against the production worker.

| # | Gap (audit §4) | Status | What closed it | Evidence |
|---|---|---|---|---|
| 1 | No true token-by-token streaming | ✅ | `callDeepSeekStream()` (`src/index.ts`) calls the provider with `stream:true`, parses SSE deltas, forwards each through `onDelta`; DO batches frames; relay emits one SSE frame per batch | Live: frames `{"text":"stream"}` + `{"text":"ing works"}` (two deltas from one reply) |
| 2 | Markdown severely incomplete | ✅ | New renderer in `web/src/lib/entertain.tsx`: GFM tables (with alignment), ordered / unordered / nested / task lists, blockquotes, links, images, `hr`, strikethrough, h1–h5, hard breaks | `entertain.tsx` block parser; `md-table` / `md-quote` / `md-nest` classes |
| 3 | No syntax highlighting / per-block copy | ✅ | `highlight()` scanner (comments, strings, numbers, keywords, booleans, fn, props, tags) + `CodeBlock` with language pill and copy button | `.md-codeblock` / `.md-lang` / `.tok-*` classes now emitted |
| 4 | No regenerate / retry | ✅ | `POST /api/chat/regenerate` (server truncates the last assistant turn, re-runs it) + per-message **regenerate** button | Live endpoint; `[data-regenerating]` state |
| 5 | No message edit + resend | ✅ | `POST /api/chat/truncate {sessionId, messageId}` (rowid truncation) + inline editor on founder turns → "Save and resend" | `store.truncateChatFrom` |
| 6 | Stop does not stop server work | ✅ | Per-stream `AbortController` map + `POST /api/chat/stop`; stop aborts the in-flight provider call, persists the partial answer and marks the stream cancelled | Live endpoints; `executeChatTurn` catch path |
| 7 | No reconnect/resume; `event: done` ignored | ✅ | `chatSse()` honours `event: done`, reconnects up to 4× resuming with `after=<frames consumed>` (server relay accepts `after`) | `api.ts chatSse`; relay `?after=` param |
| 8 | Unicode mojibake (source level) | ✅ | All mojibake literals in `chat.tsx` / `entertain.tsx` / `styles.css` replaced with correct text (em-dash, ellipsis, arrows, emoji → text labels); regression test rejects mojibake signatures and U+FFFD | `test/chat-ui.test.ts` "un-mangled text" block |
| 9 | v1 "Claude-standard" CSS had no components | ✅ | All 13 orphaned selectors are now referenced by real elements (`md-codeblock`, `md-lang`, `tok-*`, `md-nest`, `md-table`, `md-quote`, `msg-group`, `day-sep`, `first-in-group`, `edge-label`, `copied`, `data-regenerating`) | `test/chat-ui.test.ts` class-coverage block |
| 10 | No multi-model switching | ✅ | Model picker (V4 Flash / V4 Pro), server-side whitelist `CHAT_MODELS`, model recorded per assistant message | `MODELS` in `chat.tsx`; `normalizeChatModel` |
| 11 | No file/image attach | ✅ | Attach button + drag-and-drop + paste; uploads via `/api/files`, turn carries an `[attachments]` manifest the agent reads with `executive.get_file` | `addFiles()`; `attachmentManifest()` |
| 12 | No feedback capture | ✅ | `chat_messages.rating` (migration v30) + thumbs up/down with `aria-pressed` + `POST /api/chat/rate` | Live: rated `msg_mtzdn6nv…` → persisted `rating=1` |
| 13 | No long-conversation virtualization | ✅ | `MessageRow` memoized per message (+ only the live bubble re-renders) and a 120-message render window with "Show N earlier messages" | `React.memo` MessageRow; `WINDOW_SIZE` |
| 14 | Long threads silently unreachable | ✅ | Cursor pagination `GET /api/chat/messages?limit&before` → `{messages, hasMore, total}`; "Load earlier messages" in the transcript; server context now takes the **last** 40 turns (`listChatMessagesTail`) | Live: `hasMore`/`total` returned; `store.listChatMessagesPage` |
| 15 | Accessibility gaps | ✅ | `role="log"` + `aria-live="polite"` transcript, `aria-label` on every icon control, `aria-pressed`/`aria-expanded`, `role="listbox"`/`option` + keyboard nav in the sidebar, Esc = stop, `/` = focus composer, visible focus states | `chat.tsx` |
| 16 | No conversation rename | ✅ | Inline title editor + `POST /api/chat/rename` (+ `chat_session_titles` table) | Live: session `deploy_verify` renamed and read back |
| 17 | No copy-whole-conversation / export | ✅ | Header **export** menu: copy whole thread, download `.md`, download `.json` | `exportConversation()` |
| 18 | RTL / bidi unsupported | ✅ | `dir="auto"` on the transcript body, markdown container and user text; `unicode-bidi: isolate` on `.markdown` | `styles.css` |
| 19 | No font-fallback chain for emoji/CJK | ✅ | Explicit emoji + CJK fallback stack on the chat surfaces | `styles.css` font stack |
| 20 | No typing caret / streaming indicator | ✅ | Blinking `.md-caret` on the live reply + stream footer with animated dots, tool-status narration and elapsed seconds | `Markdown caret` prop; `.stream-foot` |
| 21 | Mobile: no touch-specific composer | ✅ | Sticky composer with `env(safe-area-inset-bottom)`, 44px hit targets, horizontally scrollable quick prompts, wrapping header tools | `@media (max-width: 900px)` block |
| 22 | No input length guard / paste handling | ✅ | `maxLength=8000` + character counter near the limit; pasted files are intercepted and attached instead of dumped as text | `MAX_INPUT`; composer `onPaste` |
| 23 | Session list capped at 50 | ✅ | `GET /api/chat/sessions?limit&offset` → `{sessions, hasMore, total}` + "Show more (N older)" | Live: session page + total returned |
| 24 | Copy-button feedback not wired | ✅ | Per-message and per-code-block copy state flips to "copied" for 1.6 s using the existing `.copied` / `.copied-ok` styles | `copiedKey` state |
| 25 | Message grouping / day separators | ✅ | Transcript rows carry `day-sep`, `first-in-group` and `msg-group` classes (Today / Yesterday / date separator, author grouping) | `rows` builder in `chat.tsx` |
| 26 | Latent surrogate-split risk | ✅ | Frame flushes never split a UTF-16 surrogate pair (high-surrogate hold-back) and frames are written in batches via `appendChatStreamChunks` | `executeChatTurn()` flush guard |

## Notes / known cosmetic residue

- Three empty JSX comments (`<>{/* */}`) remain in the context-rail sections: the original mojibake emoji left an invisible U+00AD soft hyphen inside them. They render nothing and are unreachable by further find/replace; remove them if the rail is rewritten.
- `provider.balance` + `jobs.interrupted_runs` doctor FAILs are unrelated to this work (documented separately).
- The `.md-task-box`, `.md-caret`, `.stream-dots`, `.menu-pop`, `.jump-latest`, `.drop-overlay`, `.reasoning*`, `.edit-box`, `.attach-*`, `.composer-*` styles are new in this pass.

## Suggested follow-ups (not gaps in the v1 list)

- Token-count display for the running reply (usage is recorded server-side per call).
- Conversation-wide search (only in-thread search exists today).
- Attachment previews (images render as chips, not thumbnails).
