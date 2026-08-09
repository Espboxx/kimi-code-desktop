# Desktop Agent Guide

## Release workflow

- Desktop releases use the version in `apps/desktop/package.json` and the matching tag `desktop-vX.Y.Z`. Update the Chinese and English README download examples when changing that version.
- Run commands from the repository root with the Node.js version in `.nvmrc` and the pnpm version pinned by the root `packageManager` field.
- During release preparation, run the complete local gate:

  ```powershell
  fnm use (Get-Content .nvmrc)
  pwsh -NoProfile -File apps/desktop/scripts/release-desktop.ps1 -Phase Verify
  ```

  It performs the frozen install, Desktop tests, typecheck, license check, build, Electron E2E, Windows x64 portable packaging, packaged-license inspection, and SHA256 generation.
- After committing the unchanged verified tree on `main`, publish it with:

  ```powershell
  pwsh -NoProfile -File apps/desktop/scripts/release-desktop.ps1 -Phase Publish -ReuseArtifacts
  ```

  `Publish` pushes `main`, creates and pushes the matching Desktop tag, waits for the Desktop Release workflow, and verifies the EXE and SHA256 assets from GitHub Release.
- Use `-ReuseArtifacts` only when the complete `Verify` phase passed and no source, dependency, documentation, or release input changed afterward. The script records and checks a deterministic workspace fingerprint, so stale artifacts are rejected.
- The default package is unsigned and disables certificate auto-discovery. Do not add signing secrets or change the GitHub workflow from this script.
