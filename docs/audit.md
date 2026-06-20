# Stable-D GUI — Phase 1–4 Code Audit

> Conducted 2026-06-19. Covers backend services, routes, and frontend modules for
> phases 1 (Install), 2 (Generate txt2img), 3 (img2img + bundles + HF downloader),
> and 4 (Configure parity + Presets).

---

## Phase Status

| Phase | PLAN.md | todo.md | Code exists? | Notes |
|-------|---------|---------|-------------|-------|
| 1 | ✅ | ✅ | Yes | Solid |
| 2 | ✅ | ✅ | Yes | Solid |
| 3 | ✅ | ✅ | Yes | Solid |
| 4 | ✅ | ❌ `[ ]` | Yes | todo.md out of date (§8 below) |

---

## Bugs - All fixed as of 2026-06-19

### 1. Release cache isn't thread-safe (Phase 1) — **Medium**

- **File:** `backend/services/sdcpp_manager.py:39-40`
- **_RELEASES_CACHE** is a module-level dict modified without a lock. Concurrent
  requests to `/api/releases` can race on writes/reads, potentially returning
  partial or stale data while a refresh is in progress.
- **Mitigation:** Cache TTL is short (60s) and writes are simple dict
  assignments, so data corruption is unlikely — but correctness requires a lock.

### 2. Unused `mode` property on model bundles (Phase 3) — **Low**

- **File:** `ui/js/flags/model-bundles.js`
- Every bundle carries a top-level `mode` property (e.g. `wan` → `"vid_gen"`,
  `sd1` → `"img_gen"`), but `flag-core.js` `applyBundleDefaults()` only reads
  `bundle.defaults.mode`. The top-level `mode` is dead code.
- The **wan** bundle happens to work because `defaults.mode: "vid_gen"` is also
  present — but bundles that omit `defaults.mode` have no mode-switching effect
  at all from their top-level `mode`.

### 3. `_RepoListingError` violates private naming convention (Phase 3) — **Low**

- **File:** `backend/routes/hf_download.py:28`
- The route references `hf_download_service._RepoListingError` — the leading
  underscore signals "private", but the exception is part of the service's public
  contract (the route must catch it to return a 502).
- **Impact:** Naming convention violation; no functional bug.

### 4. `_strip_value_flags` strips flag-name tokens anywhere in argv (Phase 2) — **Low**

- **File:** `backend/services/generate_service.py:102-111`
- `_strip_value_flags` checks every token against `{"-M", "--mode", "-o",
  "--output", "--preview-path"}`. If a user-supplied value (e.g. a prompt
  argument) happens to equal `"-o"`, it AND the next token will be incorrectly
  stripped.
- **Impact:** Extremely unlikely in practice (prompts don't begin with flag
  names), but a correctness issue worth hardening.

### 5. `--img-cfg-scale` default is empty string for float type (Phase 2) — **Low**

- **File:** `ui/js/flags/definitions.js:132`
- `type: "float"` but `default: ""`. Differs from all other float flags which
  carry numeric defaults. `getLaunchArgs()` skips empty-string defaults, so it
  works — but it's semantically confusing. Should carry a numeric sentinel (or
  be `null`-type aware).

### 6. Double state initialization in generate flow (Phase 2) — **Low**

- **File:** `backend/services/generate_service.py`
- `run()` writes the initial generation state (lines 472-486, message
  "Queued."), then `_run_job()` immediately overwrites it (lines 317-331,
  message "Starting sd-cli…"). The first write is dead code.
- **Impact:** Wasted work + a fleeting "Queued." status that no client ever sees.

---

## Code Smells

### 7. Bundle field `"all"` is a string in an array-typed API (Phase 3)

- **File:** `ui/js/flags/model-bundles.js:115` (`fields: "all"`)
- Every other bundle uses an array of field objects; the **custom** bundle uses
  a string. `generate-ui.js:209` has to special-case `fields === "all"` with a
  hard-coded list. Consumers unaware of this exception would break.

---

## Documentation Inconsistency

### 8. `docs/todo.md` Phase 4 tasks still show `[ ]`

- All three Phase 4 lines remain unchecked in `docs/todo.md`, but presets
  (routes/presets.py, ui/js/presets.js — CRUD, import/export, grouped by model
  type), custom launch args, and the full `definitions.js` flag set are all
  implemented and verified.

---

## Positive Findings

- **`generate_service.py`** — `build_argv`, `_strip_value_flags`,
  `parse_step_progress`, sidecar round-trip, and mode-specific output pathing are
  well-designed and thoroughly unit-tested (25 tests).
- **`sdcpp_manager.py`** — Asset pattern matching is correct, including the
  tricky macOS version-wildcard and AVX/AVX2/AVX512 disambiguation (verified by
  7 passing unit tests).
- **`flag-validation.js`** — Startup validation catches duplicates, unknown
  types/modes/categories, and missing enum options.
- **`presets.py`** — Deep recursive validation (`_json_safe`, depth limit 4, key
  length limits, filename reservation check) is thorough and security-conscious.
- **`hf_download_service.py`** — Input validation (repo-id regex, filename
  regex, revision regex, path-traversal guard in `_safe_destination`) is
  comprehensive.
- **AGENTS.md compliance** — All JS files pass `node --check`, all Python files
  pass `ruff check`. The UI-state sync rule (single `flagCore` source of truth)
  is followed consistently.
- **No `innerHTML` violations** — All DOM construction uses `textContent`,
  `createElement`, `replaceChildren`, `new Option`, or `Response.bytes()` —
  compliant with the project's security rule.
- **No ES module imports** — Consistent `<script>` tag global ordering as
  specified in PLAN.md §8.

---

## Summary

| Severity | Count |
|----------|-------|
| Bugs (medium) | 1 |
| Bugs (low) | 5 |
| Code smells | 1 |
| Doc issues | 1 |

**No high-severity bugs.** Phases 1-4 are solid — the code is well-structured,
well-tested, and follows the project's conventions. The issues above are
correctness hardening and cleanup.
