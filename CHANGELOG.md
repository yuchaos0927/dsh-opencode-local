# Changelog

## 0.3.3 — room for the model to be taught twice

The gate works, but the free model does not believe it the first time: a live GUI
turn spent 3 steps retrying native calls before it used the `dsh-tool` envelope.
With `steps: 6` a single tool call left two steps of headroom and any two-tool
turn would have ended in an error.

### Fixed

- `MAX_STEPS` 6 → 30. Extra steps cost nothing unless a call is actually
  refused, so the limit only ever acts as a runaway guard.

## 0.3.2 — OpenCode no longer runs tools of its own

`opencode serve` is a full agent with its own shell, file and edit tools, and it
runs them inside its own process — outside Harness approval and outside the
sandbox. That had to stop; the plugin only wants the model.

### Added

- **A private agent (`dsh-backend`) with every tool behind a permission gate.**
  The service writes a config file it owns (a fresh temp directory per child,
  passed via `OPENCODE_CONFIG`) and every session switches to that agent. The
  adapter refuses each native tool request and tells the model to use the
  `dsh-tool` envelope instead, which is the only path DSH executes.
- `toolGate` setting (default on). Turning it off restores the old behaviour.

### Why not simply disable the tools?

Measured, not assumed. With `permissions: [{action:'*', effect:'deny'}]` the
request declares **no tools**, and the free tier then answers
`FreeUsageLimitError` (HTTP 429) to every call, for every free model — the same
model that answers normally with tools declared. `ask` keeps the declaration
(the request is served) while stopping execution at the gate.

### Verified

- Live, through the plugin's own service and agent switch: a "use shell to list
  the directory" prompt produced two native calls (`shell ls -la`, then `read`),
  both refused (`permission.asked` → `replied reject`), no command executed, and
  the turn still ended with a text answer.
- Live, through the adapter: with DSH tools in the prompt the model answers with
  the `dsh-tool` envelope (`web_search`), finish `tool-calls`, no native call.
- `test/stream.test.mjs` now also covers the refusal path and asserts the
  `dsh-backend` agent is selected and the refusal message points at `dsh-tool`.
- Full suite: 24/24.

### Known

- A refused native call costs a model step. The private agent allows 6 steps, so
  a model that insists on native tools still gets a chance to answer.
- The model may answer "I could not access the files" when DSH offers no tool for
  the job; that is the gate working as intended.

## 0.3.1 — an answer no longer goes missing

A turn that made the model call one of OpenCode's own tools (read, grep, bash…)
returned **no answer at all**: the Harness showed a short "thinking" block and
finished as if the model had said nothing.

### Fixed

- **The turn now ends when the execution ends, not at the first step.** OpenCode
  splits a turn into steps; a step that calls a tool ends with `finish:
  "tool-calls"`, and the prose answer arrives in the next step. The adapter
  broke out of the event stream at that first `session.step.ended`, so everything
  after it — including the answer — was discarded. It now keeps listening until
  `session.execution.succeeded` (or `session.idle` on older builds).

- **Usage is summed over every step of the turn**, not just the last one.

- **A turn that produces no text now fails with a message instead of ending
  silently.** The failure names the cause: the model ran N of OpenCode's own
  tools and never answered, or the execution failed with a provider message.

### Verified

- Live capture against the installed OpenCode 2.2.5 client: before the fix the
  adapter yielded 43 reasoning characters and 0 text for a read-then-summarise
  prompt; after it, 218 characters of answer.
- `test/stream.test.mjs` reproduces the two-step shape, the empty-answer shape,
  and a failed execution. The first two fail against 0.3.0 (`actual: ''` vs
  `'Hello world'`; `actual: 'stop'` vs `'error'`) and pass against this build.
- Full suite: 20/20 before, 23/23 after (startup, service, adapter, stream).

### Known, unchanged

- The model may still answer by calling OpenCode's own tools. Those run inside
  OpenCode, are invisible to the Harness, and are not subject to its approval
  policy. Prompt-level tool calls (`dsh-tool` envelope) keep working and are what
  the Harness sees when the model complies.

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
