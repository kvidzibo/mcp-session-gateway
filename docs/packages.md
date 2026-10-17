# Generic package management

[README](../README.md) · [Configuration reference](reference.md#configuration)

**`/gateway` → Packages** manages installations, not service configuration or
[settings](settings.md)/[UI](native-ui.md). It neither discovers service wiring nor imports
package-specific management code. Actions stay outside model context. Updates default to manual.

## Git main: managed configuration

Git defaults to `main`. Managed packages use gateway-owned copies, never adopted checkouts; use
[local updates](#local-git-packages) for those.

```json
{
  "packageStore": ".gateway-packages",
  "packages": {
    "example": {
      "source": {
        "type": "git",
        "url": "https://github.com/vendor/example-mcp.git",
        "branch": "main"
      },
      "managed": {
        "build": [
          { "command": "npm", "args": ["ci"] },
          { "command": "npm", "args": ["run", "build"] }
        ],
        "validate": [{ "command": "npm", "args": ["test"] }],
        "timeoutMs": 300000
      }
    }
  },
  "mcpServers": {
    "example": {
      "package": "example",
      "command": "node",
      "args": ["{{packageRoot}}/dist/server.js"],
      "cwd": "{{packageRoot}}"
    }
  }
}
```

Replace URL, commands and entry point. `gateway.managed.example.json` is a template, not an
installable demo. No gateway manifest is required; non-Node builds work too, e.g. `uv sync
--locked`.

- `packageStore` defaults to `.gateway-packages` beside the config; relative paths resolve there.
  Keep it outside Git. Shared stores share activation and package locks.
- `managed` conflicts with `installedPath` and local sources; no automatic migration.
- Build is optional; validation requires a command. Commands are executables with literal arguments,
  not shell strings. Command cwd defaults to the package root; steps must stay inside it.
  Per-command timeout defaults to five minutes, maximum one hour.
- Builds use private HOME/cache and minimal PATH/locale, without service credentials or parent-agent
  API keys. Declare dependency setup; private registry/credential setup is unsupported.
- `{{packageRoot}}` substitutes into linked service command, args, cwd and env at startup, not
  through a shell. Managed/`localUpdate` launches must reference it; other external services reject
  it.

Before first activation, managed services stay stopped; invalid state or missing active directories
fail closed.

## Update all packages

**`/gateway` → Update all packages** works disconnected or with Auto update off. Review every
preview line before confirming sources, commands and effects. Approval covers resolution, build,
validation and activation; targets resolve **after approval**, unlike individual preparation. Auto
update remains unchanged.

Eligible: activated managed packages and explicit `localUpdate` checkouts, including unlinked
declarations. Inactive managed packages require first installation through **Manage releases**;
other external packages remain read-only.

[Startup safeguards](#automatic-startup-updates) apply. Escape cancels; completed changes remain
after cleanup. Failures do not stop unrelated manual updates. Local rebuilds need not change
versions. See [session effects](#effects-on-running-sessions).

## Automatic startup updates

**`/gateway` → Auto update: Off/On** saves immediately, even disconnected, without
updating/restarting services. The label rereads disk; failed saves preserve the old value. JSON
formatting changes, but other values/environment references remain. Concurrent adapter saves are
refused; remove an interrupted `<config>.auto-update.lock` only after verifying nobody is saving.

Top-level `"autoUpdate": true` (boolean; default `false`) authorizes the **Pi adapter** to update
itself and download/build/validate/activate eligible service packages before startup/reload,
**without per-update confirmation**. **Code runs with your OS permissions, not in a sandbox: authorize only trusted
sources/commands**, including manually confirmed operations. `false` disables startup writes; manual
release actions remain separately confirmed.

For service updates, only packages linked to enabled services qualify: activated managed packages and explicit
`localUpdate` checkouts. First
installs, unlinked packages and other folders do not. Standalone launches and Connection-menu
restarts do not run this policy. All updates finish before connection.

Concurrency defaults to `min(4, max(1, floor(available CPU cores / 2)))`, using Node's
`availableParallelism()` for affinity. `"autoUpdateConcurrency"` accepts integers **1–128**; `1` is
sequential. It limits whole package operations, whose steps remain sequential. Builds/tests may use
more cores; higher limits increase RAM/disk contention. Canonical Git-common-directory peers
serialize. Competing automatic managed updates wait up to five minutes, then re-plan under the
package lock; preparation and activation share that lock. Only one session builds a given update.
Manual release previews still reject contention or changed revisions. Results retain config order.

No same-startup retries. Managed failures warn and retain activation. Refused local updates may
launch existing files if guards pass: dirtiness/feature branches alone do not block launch. Local
locks, pending builds, stale receipts or missing outputs block startup; unchanged builds may be
reused. Shutdown/blocking local failure cancels active work, stops queued updates and awaits
cleanup, without reversing completed changes.

The loader names checked services; **Updating service <name>** includes builds and activation,
including initial/output-only builds. Concurrent progress shows the latest event. Successful version
changes produce one display-only **MCP servers were updated** entry with package IDs and old/new
versions, never a model turn. No entry appears for unchanged, disabled, ineligible, entirely failed
or output-only operations.

### Gateway self-updates

Before each Pi-adapter launch, including Connection-menu restarts, the gateway checks its own
checkout's public `kvidzibo/mcp-session-gateway` upstream—even with Auto update off and no service
packages configured. A
read-only check reports differing Git revisions, not proven ancestry. Network/check failures warn
without preventing an otherwise usable launch. Archives and checkouts without a supported public
main/master upstream, including feature/detached branches, skip self-checks/updates.

With Auto update on, startup/reload uses the local-update safeguards below: clean main/master,
fast-forward only, serialized updates, and no hooks, executable filters, submodules or credentials.
Shared/out-of-checkout `node_modules` or `dist` directories are refused before commands run.
Local updates and runtime-copy creation use the same Git-common-directory build lock. Each
adapter loads a separate copy of its sources, dependencies and compiled gateway, so another
session's checkout update cannot replace its files or mix cached modules.
It runs `npm ci --include=dev`, `npm run build`, then `npm run check`. The first enabled launch also
builds/validates the current revision; later unchanged launches reuse that receipt. This updates
the installation shared by configurations/sessions using this checkout—not just one config.

**Startup and `/reload` update before loading the adapter.** A disposable TypeScript worker
imports the updater under the dependency lock, then installs/builds/validates and exits. Pi copies
the completed installation under the same lock and loads that version's unique module paths.
Unchanged copies are reused. Extension discovery/help starts no updater or services. Opening a
recovery command before session startup loads a copy without updating or connecting.

Runtime copies live in Git-ignored `.gateway-runtimes/<fingerprint>` in the gateway checkout.
They contain real dependency copies (reflinks where supported), not hard links or external symlinks,
and can consume substantial disk space. Incomplete copies are never loaded. There is no automatic
pruning: remove old copies only after all Pi processes using them have exited. Existing sessions
stay pinned; `/reload` adopts current sources without restarting Pi. The first migration from the
old loader may require one fresh Pi process. Connection-menu restarts retain the loaded copy and
only check for updates. Direct CLI/built-in MCP launches remain manual.

Pre-mutation refusals warn and may launch existing files. Incomplete/failed builds block adapter
launches even with Auto update off; retry `/reload` with Auto update on to repair, or inspect
`mcp-gateway-local.log`/`mcp-gateway-local.json` in the checkout's Git directory. Keep receipts;
[local-update recovery](#local-git-packages) applies. Notifications are display-only, not model turns.

### Effects on running sessions

**Updates never restart services. Finish affected jobs in all sessions first.** Managed activation
changes future launches throughout the shared store. The Pi gateway's isolated runtime stays
unchanged; other local service updates immediately change shared files/dependencies/outputs
that running services may read. Completed changes are not rolled back.
Restart separately through [Workflow](#workflow).

## Local Git packages

Declare the Git root and explicitly link services; executables/cwd/args never imply adoption.

```json
{
  "autoUpdate": true,
  "packages": {
    "example": {
      "source": { "type": "local", "path": "/absolute/path/to/example-mcp" },
      "localUpdate": {
        "build": [
          { "command": "npm", "args": ["ci"] },
          { "command": "npm", "args": ["run", "build"] }
        ],
        "validate": [{ "command": "npm", "args": ["test"] }],
        "outputs": ["dist/server.js"],
        "timeoutMs": 300000
      }
    }
  },
  "mcpServers": {
    "example": {
      "package": "example",
      "command": "node",
      "args": ["{{packageRoot}}/dist/server.js"],
      "cwd": "{{packageRoot}}"
    }
  }
}
```

`source.path` resolves from config; one package per Git root, multiple linked services allowed.
`localUpdate` conflicts with `managed`/`installedPath`.

Updates require clean, attached **main/master**, tracking the same public upstream branch. Fetch
pins its exact ref; only fast-forward is allowed. Dirty, ahead/diverged, feature/detached,
executable-filter and submodule checkouts are refused, never reset, stashed, rebased, force-pulled,
switched or repaired. Refusal differs from launch guards.

HTTPS works; GitHub `git@github.com:owner/repo.git` and `ssh://git@github.com/owner/repo.git`
normalize to public HTTPS without SSH/credentials. Private repositories and other SSH remotes are
unsupported.

Declare commands, including dependency setup; scripts are not inferred. All steps run after pulls,
first enabled startup, changed commands or missing declared outputs; otherwise reuse builds.
Optional `outputs` may include `node_modules`/`.venv`; contents are not fingerprinted. Outputs must
be Git-ignored and inside the root. Managed command, environment and cleanup rules apply.

The Git directory holds `mcp-gateway-local.json` (HEAD/command receipt or pending marker) and
`mcp-gateway-local.log` (latest bounded output). Markers precede file changes. Failures stop startup
without reverting developer files or earlier package updates. Manual/standalone launches enforce
receipts/pending/output guards even with auto-update off. Inspect logs, fix failures, reload with
auto-update enabled to rebuild. **Do not delete receipts.** Common-directory
`mcp-gateway-local.lock` and the shared `mcp-gateway-build.lock` use
[durable recovery](#store-logs-and-recovery); inspect both journals after a crash. No individual
release/activation/rollback UI; use startup or Update all.

## Workflow

1. **Packages → Installed versions** reads local metadata; **Check for updates** contacts public
   sources. **r** refreshes locally; Arrow/Page keys scroll; Escape returns.
2. **Manage releases → package → Check source and prepare install/update** previews the exact pinned
   target, source, commands, store and effects. Review every line, then approve.
3. Preparation builds/validates a new release; only success publishes it. Git requires a clean
   active checkout and fast-forward ancestry; changed HEAD, divergence or upstream movement since
   preview fails closed. Build outputs must be Git-ignored.
4. Confirm **Activate prepared version**: future launches change atomically; existing processes
   retain old directories.
5. Confirm **Gateway → Connection → Restart gateway services…** when parent-agent turns are idle.
   **All this gateway's children stop; active/queued jobs cancel. Finish them first or decline.**
   Background job count is unknown; other Pi sessions keep running.

Restart previews old launch-snapshot names separately from newly configured launches; config edits
cannot hide stopped children. Connected restart requires `gateway-services-v1` advertising that
snapshot; disconnected recovery can explicitly start. Restart uses current config/activation,
possibly changed elsewhere, creates a new UUID and restores [native UI](native-ui.md)
conversation/branch selection. Failure stays stopped: explicitly roll back/restart; no automatic
fallback/retry.

Confirmed **Rollback** selects the previous activation, discarding the prepared candidate but
retaining files. It neither restarts, rebuilds nor reverses data migrations. Old releases remain
usable; keep persistent data outside them. Builds stay in their final directories, preserving
absolute virtual-environment paths.

## npm and external sources

For managed npm, replace `source`:

```json
{ "type": "npm", "name": "@vendor/example-mcp", "tag": "latest" }
```

Tag defaults to `latest`. Preparation pins semver and runs `npm install --ignore-scripts` in a
private prefix. Declare trusted lifecycle commands such as `npm rebuild` explicitly. `packageRoot`
is the installed package, not prefix; validate published contents, which may omit tests/dev files.
Lower targets are refused; use confirmed previous-release rollback.

Without `managed`/`localUpdate`, inventory is read-only:

```json
{
  "packages": {
    "tracked": {
      "source": { "type": "npm", "name": "@vendor/example-mcp" },
      "installedPath": "/opt/services/node_modules/@vendor/example-mcp"
    },
    "development": { "source": { "type": "local", "path": "./development-service" } }
  },
  "mcpServers": { "other": { "command": "other-mcp" } }
}
```

npm/Git may use `installedPath`; omission means unknown, not absent. Local uses `source.path`. No
PATH/global-npm scanning, `--version` execution or settings inspection. A `package` link does not
prove which installation an external command launches.

IDs start with a lowercase letter, then lowercase letters/digits/hyphens; maximum **128 packages**.
Source/package objects reject unknown keys; references must exist. Existing `mcpServers`/legacy
`servers` wiring remains supported. Pi's extension manager is separate: edit config/reload to
register or enable services, not this manager.

## Checks and safety limits

- Public npm/public HTTPS Git branches only; no private registries, authenticated SSH, embedded
  credentials, Git tags or commit-pin declarations. URLs reject whitespace, backslashes/control
  characters; Git receives canonical URLs. No service UI protocol required.
- **Git 2.45+** required; older versions fail closed. Metadata uses `--no-lazy-fetch`; no implicit
  fetch, credential helpers, askpass, personal netrc, hooks, fsmonitor or optional index writes.
  Metadata never fetches/checks out/builds; confirmed preparation does.
- Clean/process filters block dirty inspection/lifecycle actions. Submodules are not
  inspected/initialized. Trust repositories/config; do not change them adversarially.
- Manifest reads verify regular opened files, rejecting symlinks/FIFOs/devices; cap **256 KB**.
  Source checks are cancellable, maximum **four** concurrent operations, **ten-second** remote
  metadata timeout.
- Versions describe installations, not running processes. npm distinguishes older/newer; differing
  Git hashes mean **ancestry unknown** until preparation checks the new clone.
- Builds require **POSIX** process-group termination. Escape/shutdown cancels work, terminates
  groups and awaits cleanup. Scripts must not daemonize/detach workers.
- Revisions, exclusive package locks and atomic replacement reject stale previews. Uncertain
  failures never replay automatically: reread state.

## Store, logs and recovery

Store: format marker, package `state.json`, `releases/<UUID>`, `logs/<UUID>.log`. Paths/state are
not a secret boundary. Combined stdout/stderr preparation logs are owner-only, capped at **8 MB**,
potentially sensitive. **View last preparation log** privately shows a bounded tail, including
failed/cancelled attempts.

Failed preparations remove only their new staging release. Interruptions may leave orphans/locks,
never automatic activation/retry. No garbage collection or automatic unlock.

`.lock` is an append-only JSON Lines journal: owner PID/start time, command PID/PGID, executable,
cwd/start time. Detached wrappers await synced receipts before launching code; parent death before
that gate prevents launch.

**Dead owners do not prove staleness:** builds can survive SIGKILL/OOM.

1. Inspect owner and **every recorded group**, start times, executable/cwd and members, e.g. `ps -eo
   pid,ppid,pgid,lstart,args`. **Never kill by numeric ID alone:** PIDs reuse.
2. Finish/terminate survivors, then verify owner and all groups stopped.
3. Only then remove `.lock`. Incomplete/corrupt/uncertain journals require establishing no
   preparation code remains. **Never remove live locks.**

Preserve state-referenced/in-use releases; stop services before reclaiming unreferenced directories.
Unrelated source/branch changes require a new package ID.

## Validation

Run `npm run check`, `npm test`, `npm run build`. Tests avoid personal installations; visual checks
use Xvfb, private D-Bus and temporary Pi HOME/profile/project/store. **Never use production task
databases/workers as fixtures.**
