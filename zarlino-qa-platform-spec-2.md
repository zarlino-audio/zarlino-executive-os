# Zarlino Audio — QA Platform Test Specification

**Version 1.0 — Draft**
**Owner:** Khritical / Zarlino Audio
**Scope:** ZarlinoDSP shared framework + 20 shipping plugins (Headliners Series ×10, Flagship Series ×10)

---

## 0. Philosophy

Zarlino's brand promise is not "absolute quality" — that claim isn't falsifiable, and a competitor can always burn more CPU for a marginal gain. The defensible version is:

> **"Maximum audible quality per CPU cycle."**

Every plugin is evaluated against three pillars before it is allowed to open for the first time on a customer's machine. Every automated test in this spec traces back to exactly one pillar.

| Pillar | Definition | Test categories |
|---|---|---|
| **Reliability** | Never crashes, never behaves unpredictably, never corrupts state | Build, DSP Correctness, Stability & Fuzz, Real-Time Safety, Host Compatibility |
| **Efficiency** | Stays inside strict, published CPU/memory/latency budgets | Performance |
| **Experience** | Looks polished, feels intuitive, delivers the intended sound | UI Regression, UX, Listening (human) |

---

## 1. Test Unit Definition

A **test unit** is one atomic, independently pass/fail-able check with its own ID, e.g. `ZTUNE-DSP-EQ-0417`. Test units are generated from **templates × parameters** (plugin × module × platform × format × config, etc.) rather than hand-written one at a time — this is how 2,000+ units stay maintainable instead of becoming 2,000 lines of copy-paste.

**ID format:** `<PLUGIN>-<CATEGORY>-<SUBSYSTEM>-<SEQ>`
Example: `ZMASTER-PERF-CPU-0032`, `ZTAME-UI-DPI-0011`, `CORE-RTSAFE-ALLOC-0004`

**Plugin roster (20):**
- Headliners (single-purpose, lower module count): ZBloom, ZForge, ZSpace, ZPhase, ZPunch, ZGlue, ZLift, ZEcho, ZTune, ZScope
- Flagship (multi-module, higher complexity): ZScape, ZFuse, ZVault, ZWave, ZCarve, ZMaster, ZScorch, ZTame, ZMojo, ZClear
- Shared: `CORE` = ZarlinoDSP framework itself, tested once, inherited by all 20

---

## 2. Test Unit Count Summary

| # | Category | Pillar | Per-plugin avg | ×20 plugins | Core (shared) | Category total |
|---|---|---|---:|---:|---:|---:|
| 1 | Build Verification | Reliability | 12 | 240 | 12 | **252** |
| 2 | DSP Correctness | Reliability | 20 | 400 | 40 | **440** |
| 3 | Stability & Fuzz | Reliability | 8 | 160 | 16 | **176** |
| 4 | Performance Budget | Efficiency | 8 | 160 | 8 | **168** |
| 5 | UI Regression | Experience | 16 | 320 | — | **320** |
| 6 | UX Automated | Experience | 6 | 120 | — | **120** |
| 7 | Real-Time Safety | Reliability | 8 | 160 | 8 | **168** |
| 8 | Host Compatibility | Reliability | 20 | 400 | — | **400** |
| | **Automated total** | | | | | **2,044** |
| 9 | Listening (human gate) | Experience | 5 | 100 | — | 100 (not CI-counted) |

**Automated CI suite: 2,044 test units** — comfortably clears the 1,500 target. Listening tests remain a human-gated release step, tracked separately.

---

## 3. Category 1 — Build Verification (Reliability)

**Formula:** 3 formats (VST3, AU, AAX) × 2 OS (Windows, macOS) × 2 configs (Debug, Release) = 12 per plugin.
Warnings-as-errors is a pass/fail condition inside each build, not a separate unit.

Example units:
- `ZMASTER-BUILD-VST3-WIN-REL-001` — VST3, Windows, Release, zero warnings, zero errors
- `ZMASTER-BUILD-AU-MAC-DBG-005` — AU, macOS, Debug, symbol table sane
- `CORE-BUILD-STATICLIB-ALL-003` — ZarlinoDSP static lib builds clean on both toolchains

---

## 4. Category 2 — DSP Correctness (Reliability)

**Formula per plugin:** unit tests per DSP module (module count × 8 tests: impulse response, frequency response, phase response, null test vs. reference, boundary parameter values, mono/stereo/multichannel, sample-rate independence, bypass = bit-exact passthrough) + 5 golden-reference-audio comparisons + 3 determinism/bit-exact repeat runs + 4 parameter-sweep mathematical validations.

Example units:
- `ZTUNE-DSP-PITCH-0012` — pitch-shift null test against golden reference at +12/-12 semitones
- `ZMASTER-DSP-LIMITER-0044` — brickwall ceiling never exceeded across 10k random input peaks
- `CORE-DSP-BIQUAD-0007` — RBJ cookbook coefficients match reference within 1e-6 across all 8 filter types
- `ZGLUE-DSP-COMP-0021` — same input + same params ⇒ bit-identical output across 100 runs (determinism)

---

## 5. Category 3 — Stability & Fuzz (Reliability)

**Formula per plugin:** 8 fuzz suites, each run millions of iterations under CI, counted as one test unit per suite (pass = zero occurrences of the target failure across the full run):
1. Random parameter combinations — no crash
2. NaN injection at input — must not propagate
3. Infinity injection at input — must not propagate
4. Denormal-heavy input (near-silence tails) — no CPU spike, no NaN
5. Rapid automation (host sends thousands of param changes/sec)
6. Sample-rate change mid-stream (44.1k → 192k → 44.1k)
7. Buffer-size change mid-stream (32 → 8192 samples)
8. Memory sanitizer / ASan pass over a 24-hour soak run

Example units:
- `ZSCORCH-FUZZ-NAN-002` — NaN in, silence or last-good-sample out, never NaN out
- `CORE-FUZZ-DENORMAL-001` — RAII denormal guard holds CPU flat during a -120dBFS sine tail

---

## 6. Category 4 — Performance Budget (Efficiency)

**Formula per plugin:** 8 units — CPU% (reference machine, mono), CPU% (stereo), memory footprint at idle, memory footprint at peak, zero heap allocations during `processBlock`, plugin init time < 100ms, preset load time, preset save time.

Each unit compares against a **published budget** and fails CI if a change regresses it — this is the "competitive advantage" mechanism: a slower build never ships.

**Reference machine (locked):** 4-core CPU, 4GB RAM — this is the actual dev/build machine, and it doubles as the floor spec. There's no second lower-spec machine because this one already is the floor; if it runs comfortably here, it runs comfortably on anything a customer owns. Revisit only if the dev machine changes.

Example units:
- `ZTAME-PERF-CPU-STEREO-003` — CPU ≤ 0.3% on reference machine (4-core / 4GB RAM, 48kHz/128 buffer)
- `ZVAULT-PERF-ALLOC-000` — zero `malloc`/`new` calls observed via allocation hook during 60s of processing
- `CORE-PERF-INIT-001` — cold plugin instantiation ≤ 100ms

---

## 7. Category 5 — UI Regression (Experience)

**Formula per plugin:** 4 DPI scales (100/125/150/200%) × 2 themes (light/dark, where applicable) × 2 OS = 16 screenshot comparisons per plugin against approved reference images.

**Diff methodology (locked):** raw pixel-diff alone is too flaky for CI — font anti-aliasing and subpixel rendering shift a few pixels between runs on the same machine and would generate false failures on every build. Two-stage check instead:
1. **Structural similarity (SSIM) ≥ 0.98** against the approved reference — catches real layout problems (missing elements, misalignment, broken scaling) while tolerating harmless rendering noise.
2. **Pixel-diff ≤ 1.0%** on top of that, as a second check for color regressions and small readable-text problems SSIM can miss.
A screenshot fails if it trips either threshold. Both numbers are starting points — tune them after the first reference-image library is captured and you see real false-positive/negative rates.

Flags checked automatically: overlapping text, clipped labels, controls outside window bounds, misaligned controls, missing images, incorrect fonts, broken scaling, color regressions.

Example units:
- `ZWAVE-UI-DPI150-WIN-DARK-009` — 150% DPI, Windows, dark theme, SSIM ≥ 0.98 and pixel-diff ≤ 1.0%
- `ZCARVE-UI-DPI200-MAC-LIGHT-013` — 200% DPI, macOS, light theme, no clipped labels

---

## 8. Category 6 — UX Automated Checks (Experience)

**Formula per plugin:** 6 objective checks — all controls reachable via tab order, tab navigation cycle completes without trap, every automatable parameter has a correct host-visible automation name, every control has a tooltip, minimum text contrast ratio met, no control smaller than minimum touch/click target.

Example units:
- `ZMOJO-UX-TABORDER-002` — tab order visits every control exactly once, no traps
- `ZFUSE-UX-AUTOMNAME-014` — automation name for "Drive" param matches spec string exactly

---

## 9. Category 7 — Real-Time Safety (Reliability)

**Formula per plugin:** 8 static/dynamic checks on the audio thread — no heap allocation, no lock acquisition, no `sleep`/blocking wait, no disk I/O, no network I/O, no C++ exceptions thrown or caught, no unbounded loops, no syscalls of any kind. Verified via instrumented builds + static analysis pass.

Example units:
- `CORE-RTSAFE-ALLOC-004` — allocation hook fires zero times during 10-minute stress run
- `ZSPACE-RTSAFE-LOCK-006` — lock-free ring buffer confirmed via static analysis, no mutex on audio thread

---

## 10. Category 8 — Host Compatibility (Reliability)

**Host list (locked):** picked for zero-cost testability — no purchase required for any of them:
1. **FL Studio** — already owned
2. **REAPER** — unlimited fully-functional evaluation, no payment required to keep testing
3. **Cakewalk by BandLab** — free forever, Windows only, historically strict VST validation (good bug-catcher)
4. **Ableton Live** — 90-day full-featured trial, high weight since it's a major share of your customer base
5. **Waveform Free** (Tracktion) — free, cross-platform, different automation/plugin-hosting implementation from the others, good coverage diversity

No Logic Pro or Cubase — both require a paid license, so they're out of scope until there's budget or a customer-donated license for testing. Worth revisiting once Zarlino has revenue to justify the purchase, since Logic in particular is a large share of the macOS producer market.

**Formula per plugin:** 5 hosts × 4 checks (load without error, automation read/write round-trip, preset save/load round-trip, clean close with no leaked handles) = 20 per plugin. Offline/bounce rendering is folded into the "automation round-trip" check per host.

Example units:
- `ZPUNCH-HOST-REAPER-LOAD-001` — loads in REAPER without error dialog
- `ZLIFT-HOST-CAKEWALK-PRESET-003` — save preset, reload project, parameter values bit-identical
- `ZWAVE-HOST-ABLETON-AUTOMATION-007` — automation curve round-trips through save/reload unchanged
- `ZFORGE-HOST-WAVEFORM-CLOSE-002` — clean unload, zero leaked handles (verified via handle count before/after)

---

## 11. Category 9 — Listening Tests (Human gate, not CI-counted)

**Formula per plugin:** 5 qualitative questions, answered by a human reviewer before release sign-off:
1. Does it achieve its stated sonic goal?
2. Does it sound musical across the intended use range?
3. Is it inspiring to use, not just correct?
4. Would an engineer choose it over the named competitor it targets?
5. Does it hold up on both a treated room and consumer headphones?

These are release gates, not CI tests — no automated system can answer them reliably, and they aren't included in the 2,044 automated count.

---

## 12. CI / Release Gating Policy

- **Merge to main:** Categories 1, 2, 3, 7 must be 100% green. No exceptions.
- **Nightly build:** Categories 4, 5, 6, 8 run in full; any regression against the last approved baseline blocks promotion to release-candidate.
- **Release candidate:** All 2,044 automated units green + Category 9 human sign-off required before a plugin is opened for the first time by a customer.
- **Regression = automatic fail:** if a change makes CPU%, memory, init time, or preset-load time worse than the last approved baseline, the build fails even if every functional test passes. Efficiency is a release gate, not a nice-to-have.

---

## 13. Decisions Log

All three open items from v1.0 are resolved:

| Item | Decision |
|---|---|
| Reference machine (Category 4) | 4-core CPU / 4GB RAM — the actual dev machine, doubling as the floor spec |
| Host list (Category 8) | FL Studio, REAPER, Cakewalk by BandLab, Ableton Live (trial), Waveform Free — none require a purchase |
| Screenshot tolerance (Category 5) | SSIM ≥ 0.98 AND pixel-diff ≤ 1.0%, tuned after the first reference-image capture |

**Still worth revisiting later, not blocking:** adding Logic Pro / Cubase to Category 8 once there's revenue or a donated license to justify it — both are meaningful DAW-market share, especially Logic on macOS.
