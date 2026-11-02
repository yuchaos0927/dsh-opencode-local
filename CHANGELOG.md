# Changelog

## 0.3.0 — startup safety

This release fixes the failure mode that could take the whole Harness down on
launch. It is a hardening release: the model plumbing is unchanged.

### Fixed

- **The plugin no longer starts `opencode serve` during Harness boot.**
  `apply()` used to spawn the child process immediately, putting an external
  binary that this plugin does not control onto the startup critical path. A
  slow, failing, or wedged child could delay or break startup. The service now
  starts on first real use — the first model listing or the first call —
  which is the moment a user actually asked for one of these models.

- **`apply()` can no longer throw into the Host.** Config values are normalized
  before use, and the whole setup runs inside a guard. A third-party plugin must
  never abort a Harness boot or a settings projection that merely enumerates
  installed plugins.

- **A duplicate adapter registration no longer half-wires the plugin.**
  Previously the duplicate was swallowed and the plugin kept registering its
  provider directory and model discovery while holding no adapter. It now logs
  and stays inert, and it no longer risks leaking a second child process.

- **Cleanup actually releases every registration.** The disposer returned from
  `registerConfigurableProviders` / `registerModelDiscovery` was previously
  dropped; on unload the adapter registration was not released either.

### Added

- `test/` — 20 tests covering the startup contract, the child-process
  lifecycle, and the lazy-start path. Run them with `npm test`.
- `CHANGELOG.md`.

### Changed

- The provider's display name is now **OpenCode** (it was `OpenCode (this
  machine)`). The provider id `opencode-local` is unchanged, so saved model
  selections keep working.

### Verified

- Full suite green: 20/20, including against an empty `HOME` (no OpenCode
  installed, no `~/.dsh`), which is what CI runs.
- The same startup suite run against 0.2.0 fails 7/10, including one test that
  hangs because 0.2.0 really does spawn a process from `apply()`.
- Installed into an isolated profile and booted: no child process at startup,
  `opencode-local` registered in the provider directory, and the settings RPC
  that used to fail now returns `ok: true`.
- Installed into a real desktop profile and restarted: entry reaches
  `fiberPhase: "active"`, the provider is registered, and no crash report is
  produced. The service starts on the first catalog read, not during boot.

### Documented

- **Installing into a running Host is unreliable; fully restart afterwards.**
  Observed in practice: the install reported `application: failed` with
  `failed to import` / `ERR_MODULE_NOT_FOUND` for a package that was installed,
  because the runtime had pointed some `@deepseek-ai/*` packages at a temporary
  directory that was already gone. The plugin unpacked correctly and reached
  `fiberPhase: "active"` after a full quit and relaunch, with no crash report.
  See the Install section of both READMEs.
- **Dangling `@deepseek-ai/*` symlinks in a profile are normal**, not damage:
  some packages are supplied by the packaged runtime at run time and never
  resolved through the profile. Repointing them at self-made copies was tested
  and broke `llm`, `session`, and `settings` — do not "repair" them.

## 0.2.0

- Reworked the free-model path to reuse the installed OpenCode client through
  its loopback `serve` API instead of impersonating it over the network.
- Prompt-level tool protocol so DSH keeps owning tool declaration and execution.

## 0.1.0

- Initial local service and adapter.
