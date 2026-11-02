# dsh-opencode-local

Use the models of the [OpenCode](https://opencode.ai) client installed on your own
machine — **including free-tier models** — inside
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), while DSH
keeps its own tool system.

## Why this plugin exists

OpenCode's free models **only answer requests made by the OpenCode client itself**:

> Free-tier chat models are only available from within OpenCode. Other harnesses
> receive HTTP `403` for those models, even with a Console API key.
> — [opencode.ai/v2/docs/console/harnesses](https://opencode.ai/v2/docs/console/harnesses)

Calling opencode.ai directly from DSH therefore cannot work, and forged request
headers only yield `FreeUsageLimitError`.

## What this plugin does instead

**Nothing is spoofed. It reuses the OpenCode client already installed on the machine.**

```
DSH  →  this plugin  →  127.0.0.1:<random port>  →  opencode serve (official client)
                                                             ↓
                                                        free models ✅
```

The plugin:

1. locates the local `opencode-cli` (following the version directory the desktop
   app rotates, and falling back to `PATH`),
2. starts `opencode serve` on loopback **the first time a model is actually
   used** — never during Harness boot (see below),
3. reads the random password it prints on startup and authenticates with Basic Auth,
4. maps DSH turns onto its `session/prompt` + `session/*` event stream,
5. stops the child process when the plugin unloads, leaving no port behind.

The request is issued by the **official client**, so the upstream policy is met.
No public proxy is involved; traffic never leaves `127.0.0.1`.

### Why the service does not start at boot

Earlier versions spawned `opencode serve` from the plugin's `apply()`. That put
an external program this plugin does not control onto the Harness's startup
critical path: if it was slow, failing, or wedged, it dragged on startup.

The service is now **lazy**. During Harness boot the plugin only registers its
adapter, provider directory and model discovery — it runs no child process.
The child starts when you actually pick one of these models, or when the model
picker asks for the catalog.

`apply()` also normalizes its config and runs inside a guard, so the plugin
cannot abort a Harness boot or a settings projection that merely enumerates
installed plugins.


## How tool calling works

OpenCode is a complete agent: it declares and runs its own tools, and exposes no
interface for injecting an external tool list. DSH's stream protocol also has no
"provider already executed this" block, so tools cannot be forwarded as a channel.

This plugin uses **prompt-level function calling**:

```
1. DSH tool schemas are rendered into the prompt.
2. When a tool is needed the model answers with a ```dsh-tool fence holding a JSON array.
3. The plugin detects that fence in the stream and turns it into native DSH tool-call blocks.
4. DSH executes the tool (permissions, approvals, skills all stay in DSH's hands).
5. The result returns to the model as a Tool result on the next turn.
```

**Upside**: DSH's tool system, permissions and multi-step orchestration are untouched;
OpenCode is purely a model backend.

**Cost**: this relies on instruction-following rather than a protocol-level channel.
Strong models comply reliably; weak ones may need the adapter's retry.

## Requirements

- The **OpenCode desktop app** installed (it ships `opencode-cli`), or `opencode` on `PATH`
- macOS (binary discovery currently follows the macOS desktop layout)
- DSH runtime `0.2.1-rc.2` or newer

Not required: the OpenCode desktop app running, an OpenCode Go subscription, or a
Console API key.

## Install

```sh
dsh plugin --profile desktop add /path/to/dsh-opencode-local
```

Or edit the profile's `package.json`:

```jsonc
"dependencies": { "dsh-opencode-local": "link:/path/to/dsh-opencode-local" },
"dsh": { "profile": { "bundles": [ ..., "dsh-opencode-local" ] } }
```

Restart DSH, then pick a model under **OpenCode** in the model picker.

### Restart after installing

Install the plugin, then **fully quit and relaunch** DSH before expecting it to
work. Installing into a running Host is not reliable: the install may report
`application: failed` with `failed to import` / `ERR_MODULE_NOT_FOUND` for a
package that is plainly installed.

One case observed: during installation the runtime points some
`@deepseek-ai/*` packages (`dsh-llm`, `cordis`) at a temporary directory via
symlink, and that directory may already be gone by the time the import runs.
The plugin itself unpacks correctly; only that one import attempt fails. **Fully
quitting and relaunching** loads it normally.

Judge success by the plugin entry's real state (`fiberPhase: "active"`), not by
the install message alone. In our run the install reported failure, and after a
restart the entry was active with no crash report produced.

Separately: dangling symlinks under
`~/.dsh/profiles/<name>/node_modules/@deepseek-ai/` are a **normal artifact** of
this install model — some packages are supplied by the packaged runtime at run
time and never resolved through the profile. Do **not** try to "repair" them.
Repointing the profile's `@deepseek-ai/*` at self-made copies was tested and
broke `llm`, `session`, and `settings` from loading at all. They do not affect
this plugin.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `providers` | `["opencode-local"]` | Provider ids this plugin answers for. Changing it invalidates saved model choices |
| `cliPath` | auto-discovered | Explicit `opencode-cli` path |
| `port` | `0` (automatic) | Loopback port |
| `directory` | process cwd | Working directory reported to the local service |
| `modelRefreshIntervalMs` | `600000` | How long the model list is cached |
| `logLevel` | `warn` | `debug`/`info`/`warn`/`error`/`off` |
| `logDir` | `~/.dsh/logs/dsh-opencode-local` | Log directory |
| `logMaxBytes` / `logMaxFiles` | `524288` / `5` | Size cap and retention |

Logs never contain conversation content, tool arguments or credentials.

## Tests

No dependencies to install — the suites load through stubs, so this works in a
fresh clone:

```sh
npm test
```

The `--import ./test/loader.mjs` flag is required for two of the suites: without
it the runtime cannot resolve the `@deepseek-ai/*` peer dependencies that only
exist inside a DSH installation. `npm test` carries the flag; run the suites
individually only if you reproduce it:

```sh
node --import ./test/loader.mjs --test test/startup.test.mjs
node --test test/local-service.test.mjs
node --import ./test/loader.mjs --test test/adapter.test.mjs
```

20 tests across three areas:

- **Startup contract** (`test/startup.test.mjs`): missing or malformed config
  never throws; nothing is spawned during boot; a duplicate adapter
  registration stays inert; disposal releases every registration.
- **Child-process lifecycle** (`test/local-service.test.mjs`): concurrent
  `start()` calls share one launch; `stop()` really reaps the process; a child
  dying during startup rejects instead of reporting ready.
- **Lazy start and adapter** (`test/adapter.test.mjs`): the first catalog read
  starts the service, and the catalog is normalized correctly.

These drive a fake CLI, so no OpenCode installation is required.

## Known limitations

- **Requires the local OpenCode CLI.** Without it the plugin reports `OpenCode CLI not found`
  (on first use, not at startup).
- **Free quota is a limited upstream policy.** Once exhausted, free models return empty
  responses; switch to a paid model to continue.
- **No settings UI.** Adjust the profile configuration instead.
- **No GUI tool cards.** DSH really runs the tools, but the protocol produces no native
  tool events, so visibility in the transcript is limited.
- **Image input is untested in a live session.** The layer below works (the local service
  accepts data URLs).

## License

MIT. Parts of `lib/logger.js` and `lib/logger.d.ts` derive from the MIT-licensed
`dsh-opencode-bridge`; its copyright notice is kept in [LICENSE](LICENSE). The rest —
local service lifecycle, the prompt-level tool protocol and the LLM adapter — is this
project's own implementation.
