# StableDfusion Polish Todo

Quick wins for making the app feel nicer, clearer, and more user-friendly.

## Generate

- [x] Move Model setup above optional image references and metadata so the required model selection is easier to find.
- [x] Make the Generate action easier to reach after editing settings.
- [x] Add a clearer first-run empty state in the preview/result panel.
- [x] Collapse Inspect metadata by default so it feels like a utility, not part of the main generation path.
- [x] Add model readiness/status chips near required model fields.

## Hugging Face Download

- [x] Make the disabled Download button visibly disabled.
- [x] Group fetched files by destination/type: Diffusion, VAE, Text Encoders, LoRAs, Other.

## Server & API

- [x] Collapse advanced server/model fields by default.
- [x] Add a compact server configuration summary.
- [x] Sync sd-server model/component/runtime settings with Generate and Configure shared state.

## Install

- [x] Polish the Installed block with compact badges for version, backend, and executable health.
- [ ] Auto-download the ROCm runtime for the ROCm backend (mirrors lemonade): detect GPU gfx arch, map to TheRock family name, download `https://repo.amd.com/rocm/tarball/therock-dist-windows-<family>-<rocm_ver>.tar.gz` (~4.3–5.1 GB per arch; `rocm_ver` must match the version embedded in the sd asset name), extract via `tarfile` to a separate `sdcpp/therock/<arch>-<ver>/` tree (NOT flattened into `bin/` — `rocblas/library/` subdirs must survive), prepend `therock/.../bin` to `PATH` at launch, skip if a matching system ROCm exists (`ROCM_PATH`/`HIP_PATH`). Wire in as a companion step in `install_release` (`backend/services/sdcpp_manager.py`). Reference: lemonade `src/cpp/server/backends/backend_utils.cpp` (`install_therock()`) + `src/cpp/resources/backend_versions.json`.
  Implementation guardrails (from code review):
  - **Skip if already present** — bail if `sdcpp/therock/<arch>-<ver>/bin` exists so re-installs / re-releases don't re-download the 4.3–5.1 GB tarball.
  - **Staging-then-swap the extract** — mirror `install_release`'s staging discipline (extract to a temp dir, then swap) so a disk-full / interrupted extract never leaves a partial tree that a naive existence check launches against.
  - **Reuse `backend_specs`, don't fork a second version table** — extend the per-variant ROCm rows (rocm-7.1.1 / rocm-7.13.0 etc. in `backend/specs`/`sdcpp_manager.py`) so a new upstream `rocm_ver` doesn't 404 a 4–5 GB download against a stale parallel map.
  - **Runtime path must grow multi-path** — `_build_process_env` (`backend/services/process_manager.py`) currently feeds a single path from `get_active_runtime_bin`; TheRock lives in a separate tree, so thread the therock dir through it rather than ad-hoc PATH wiring in `launch_process`.
  - **Reconcile the stale error path** — gfx-arch detection belongs in the backend install layer, not the UI backend picker. And once auto-download ships, update the leftover launch-time gate — the `hipblas.dll` missing check + "Install the AMD ROCm toolkit" error text (`process_manager.py`) and the "toolkit required" label (`sdcpp_manager.py`) — or it keeps rejecting valid setups and neutralizes the fix.

## General Visual Polish

- [ ] Add consistent icons to common action buttons: Refresh, Browse, Copy, Download, Open Folder, Delete.
- [x] Improve surface hierarchy between tool panels, image frames, and settings cards.
