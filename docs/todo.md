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

## General Visual Polish

- [ ] Add consistent icons to common action buttons: Refresh, Browse, Copy, Download, Open Folder, Delete.
- [x] Improve surface hierarchy between tool panels, image frames, and settings cards.
