# Generic package management

The gateway separates **package sources/installations**, **MCP service launch
configuration**, and **service-owned settings/UI**. It never scans package folders
for service configuration or imports package-specific management code.

The Pi adapter's `/gateway` menu groups inventory, preparation, activation and
rollback under **Packages**, and restart under **Connection**. These are operator actions, not
model tools or messages. Updates are manual by default; the Pi adapter also supports
the explicit startup opt-in below.

## Git main: managed configuration

Use a Git source tracking `main` (also the default). The manager clones its own
copies; it never adopts an existing development checkout. To update a checkout
in place instead, explicitly configure [local packages](#local-git-packages).

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

Replace the URL, build/validation commands and entry point with the service's
actual instructions. `gateway.managed.example.json` is a starting template, not
an automatically installable demo. No gateway-specific package manifest is needed.
Non-Node Git packages work too: for example a declared `uv sync --locked` step
can create a project-local Python environment.

- `packageStore` defaults to `.gateway-packages` beside the configuration. Relative
  paths resolve there, not against Pi's cwd. Keep it out of Git. Multiple sessions
  using the same store share activation state and per-package write locks.
- `managed` opts into gateway-owned copies. It cannot accompany `installedPath`
  or a local source. No automatic migration from existing folders occurs.
- `build` is optional; `validate` requires at least one command. Commands are
  executables plus literal arguments, **not shell strings**. `cwd` defaults to
  the package root; a subdirectory such as `pi` must resolve inside that root.
  Each command has the package's timeout (default five minutes, maximum one hour).
- The complete source, pinned version, commands, store and effects are previewed
  before preparation. Every preview line must be reviewed before Enter confirms.
  Downloaded code and build/validation commands are trusted executable code with
  your OS permissions, **not sandboxed**. Only configure trusted packages/commands.
- Builds get a private home/cache and a minimal environment with PATH/locale,
  not service credentials or the parent agent's API keys. Declare required setup
  in the commands; private package registries and credential setup are not supported.
- `{{packageRoot}}` is replaced in linked service commands, arguments, cwd and env
  at gateway startup. Managed launches must reference it. It is not a shell
  expression. Explicit `localUpdate` packages also support it; placeholders are
  rejected on other external services.
- Before first activation a managed service stays stopped, so the manager remains
  usable to install it. An invalid state/missing active directory fails closed.

## Automatic startup updates

Select **`/gateway` → Auto update: Off/On** to toggle and automatically save the
selected gateway config, without a second confirmation. The label refreshes from
disk; save failures leave the previous value in place and report an error. This
works while disconnected and does not immediately update or restart any service.
Saving rewrites JSON formatting but preserves other values, including environment
variable references. A concurrent adapter save is refused; an interrupted save
may leave `<config>.auto-update.lock`. Remove that lock only after verifying no
session is still saving.

Alternatively set top-level `"autoUpdate": true` in the gateway config (default
`false`; only a boolean is accepted). Enabling this authorizes the **Pi adapter** to check public sources
on startup/reload and prepare, build, validate and activate changed versions
without individual confirmations, before starting any child servers.
Already-activated managed packages and explicitly configured `localUpdate` Git
checkouts linked to services qualify. First managed installs, unlinked packages
and other external/local folders remain manual.
The standalone stdio gateway does not run this adapter policy.

Eligible packages update concurrently. The default limit is
`min(4, max(1, floor(available CPU cores / 2)))`, using Node's `availableParallelism()`
so process CPU affinity is respected. Set top-level `"autoUpdateConcurrency": 1`
for sequential updates, or any integer from **1 to 128** to override the limit,
including values above four. The limit counts whole package operations; each
package's build and validation steps still run in order. Builds/tests may use
multiple cores themselves, so higher limits can increase RAM and disk contention.
No services connect until all updates finish; the update summary retains config order.

All existing pinned-version, clean-tree, ancestry/downgrade, locking, validation,
logging and cancellation checks still apply. Managed-release failures warn and
leave the current activation in use. Local checks may skip an unchanged checkout,
but incomplete local builds block startup (see below). No same-startup retries.
Shutdown or a startup-blocking local failure stops queued updates, cancels active
operations, and awaits their cleanup before returning. Completed changes are not
rolled back. No existing processes in other sessions are restarted. Managed
activation affects their next launch; **local
updates mutate shared files immediately**, including dependencies and build output
that running processes may still read.
Manual Connection-menu restarts do not check for updates.

During initial startup/reload, the animated startup loader names each service
being checked. When a newer version is found, it shows **Updating service <name>**
while preparing, building, validating and activating the package, before connecting
services. Local packages also show this stage when rebuilding missing output or
validating a checkout for the first time. Fully current services show only checking.
With concurrent updates, the loader shows the most recent package progress event,
not an inventory of every active operation.

After successful version changes, one display-only chat entry says **MCP servers were updated**
and lists package IDs and old/new versions. Nothing is posted when up to date,
disabled, ineligible or entirely failed. The entry never starts a model turn.

Enabling this setting grants ongoing permission to execute the configured trusted
build/validation code with your OS permissions, not in a sandbox. Enable it only
for trusted sources and commands. `false` disables startup writes; managed-release
operations remain separately confirmed. Local updates have no manual release UI.

## Local Git packages

Declare the existing repository root, opt it into `localUpdate`, and link its
service explicitly. No repository is inferred from an executable, cwd or argument.
A plain local source remains read-only inventory.

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

- `source.path` resolves relative to the gateway config and must be a Git root.
  Use one package per checkout; multiple services can link to that package.
  `localUpdate` cannot accompany `managed` or `installedPath`.
- Updates require a clean attached **main/master** branch tracking the same branch
  on a public remote. The updater fetches the exact upstream ref and fast-forwards
  to its pinned commit. It never resets, stashes, rebases, force-pulls or changes
  branches. Dirty, ahead/diverged, feature/detached branches, executable Git
  filters and submodules are refused; nothing is automatically repaired.
- HTTPS remotes are supported. GitHub `git@github.com:owner/repo.git` and
  `ssh://git@github.com/owner/repo.git` are checked over public HTTPS, without SSH
  or credentials. Private repositories and other SSH remotes are unsupported.
- Build and validation commands are explicit, not inferred from package scripts.
  Include dependency setup (`npm ci`, `uv sync --locked`, etc.) when needed. All
  configured steps run after a pull, on the first enabled startup, when commands
  change, or when a declared `outputs` path is missing. Otherwise builds are
  reused. `outputs` is optional; include dependency directories such as
  `node_modules` or `.venv` if their absence should also trigger setup. No content
  fingerprint of output files is taken. Build outputs must be Git-ignored. Steps and outputs must stay inside the root.
- `validate` requires at least one command; `build` may be empty. The same minimal
  environment, private HOME/cache, per-command timeouts and process-group cleanup
  as managed builds apply. Service env/API credentials are not passed to builds.
- `{{packageRoot}}` binds to the checkout, and must appear in its service launch.
  Successful local changes appear in the normal startup-update summary. An
  initial build or output-only rebuild does not claim a version update.
- The Git directory contains `mcp-gateway-local.json` (successful HEAD/command
  receipt or pending-build marker) and `mcp-gateway-local.log` (latest bounded
  operation output). A marker is written **before** modifying files. Build or
  validation failure does not roll back developer files: startup stops rather
  than launching stale output. Earlier package updates may already have applied;
  there is no cross-package rollback. A later auto-update startup retries the build.
  Manual/standalone launches also reject pending builds, changed receipts or
  missing declared outputs, even with auto-update disabled. Fix the failure and
  reload with auto-update enabled; inspect the log rather than deleting receipts.
- A common-Git-directory `mcp-gateway-local.lock` serializes sessions and worktrees.
  It uses the same durable owner/process-group journal and stale-lock recovery
  requirements as managed packages below. Never delete a live lock.
- **Unlike managed releases, these are in-place writes.** Other running sessions
  are not restarted, but may observe changed files or dependencies. Finish their
  jobs before enabling this for a shared development checkout. There is no local
  activation/rollback operation in Manage releases.

## Workflow

1. Open **`/gateway` → Packages**. **Installed versions** reads local metadata;
   **Check for updates** contacts public sources. In the version view, **r** reads
   locally, Arrow/Page keys scroll, and Escape goes back.
2. Choose **Manage releases**, select a package, then **Check source and prepare
   install/update**. Approve the exact pinned target and command list.
3. The manager downloads into a new release directory, builds, and runs every
   validation command. It publishes the prepared release only on success. Git
   requires a clean active checkout and a fast-forward ancestry relationship;
   changed HEAD, divergence and an upstream branch moving since preview all fail
   closed. Build output must be ignored by Git, not dirty tracked/untracked source.
4. Separately choose **Activate prepared version** and confirm. This atomically
   changes the version used by **future launches in all sessions sharing the
   store**. Existing processes continue using their old directories.
5. To apply it to this session, return to **Gateway → Connection** and choose
   **Restart gateway services…**, then confirm. It restarts **all children of this gateway**,
   not a selected child. Other Pi sessions are not restarted. Parent agent turns
   must be idle; background job count is unknown. The explicit warning states that
   active/queued jobs will be cancelled—finish them first or decline.

Restart previews the old gateway's launch-snapshot service names separately from
newly configured launches, so editing/removing a config entry cannot hide a child
that will be stopped. The gateway advertises that snapshot in its private
`gateway-services-v1` experimental capability; without it restarting a connected gateway is
unavailable. A disconnected gateway can still be explicitly started for recovery. Restart uses the configuration and active versions at startup, which
another session may have changed. The gateway run UUID changes; saved native UI
conversation/branch selection is restored. Restart failure leaves the connection
stopped: rollback and restart again explicitly, with no automatic retries/fallback.

**Rollback** separately confirms switching future launches to the previous active
release. It discards any pending prepared candidate because that candidate was
checked against a different active base (files are retained). It does not restart
processes, rebuild code, or roll back external data migrations. Old release directories are retained, so existing processes and
previous versions remain usable. Commands must keep persistent application data
outside release directories. Absolute paths in virtual environments remain valid:
release directories are built in their final location, never renamed after build.

## npm and external sources

For managed npm packages, replace `source` with:

```json
{ "type": "npm", "name": "@vendor/example-mcp", "tag": "latest" }
```

The tag defaults to `latest`. Preparation pins the resolved semver and runs
`npm install --ignore-scripts` in a new private prefix. Automatic dependency
lifecycle scripts are disabled. If required, explicitly declare trusted build
commands such as `npm rebuild`. `packageRoot` is the installed package directory,
not the prefix. Validation must suit the published package (development/test files
may not be published). Lower npm targets are refused for preparation; switching
back uses the separately approved previous-release rollback action.

Without `managed` or `localUpdate`, existing read-only inventory remains unchanged:

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

Existing npm/Git installations may declare `installedPath`; omission means the
installed version is unknown, not necessarily absent. Local sources use
`source.path`. No PATH/global-npm scan, `--version` execution or service-settings
inspection occurs. Local folders without `localUpdate` remain externally managed;
unlinked local declarations are never updated.
A `package` reference links inventory but does not prove an external command
launches that installation. Several services may link to one package.

Package IDs use lowercase letters, digits and hyphens, starting with a letter;
at most 128 are allowed. Source/package objects reject unknown keys and service
references must exist. All unchanged `mcpServers`/legacy `servers` entries continue
to work. Pi's own extension-package manager is separate; this manager does not
edit Pi settings, load extensions, register new services or enable/disable entries.
Edit configuration explicitly and reload to change that wiring.

## Checks and safety limits

- Public npm registry only; public HTTPS Git branch sources only (local GitHub SSH
  remotes are normalized to HTTPS as above). No authenticated SSH, private
  registries, embedded URL credentials, tags or commit-pin source declarations.
  URLs reject whitespace, backslashes and control characters; Git receives the
  canonical validated URL. No service UI protocol is needed for package management.
- Git **2.45+** is required. Metadata commands use `--no-lazy-fetch`; older Git
  fails closed. No implicit partial-clone fetches, credential helpers, askpass,
  personal netrc lookup, hooks, fsmonitor or optional index writes. Metadata
  checks never fetch, checkout or build. Confirmed preparation is the separate
  code-download/build path.
- Read-only dirty inspection is unavailable when clean/process filters are
  configured; lifecycle actions reject those checkouts rather than execute filters.
  Submodule contents are not inspected or initialized automatically. Repositories
  and config must be trusted and not adversarially changed during an operation.
- Metadata manifests must be regular files, not symlinks/FIFOs/devices; reads
  verify the opened handle and enforce a 256 KB cap. Source checks are bounded,
  cancellable and limited to four concurrent operations. Each remote metadata
  request has a ten-second timeout.
- Versions describe declared installations, not running processes. npm distinguishes
  newer/older targets. Git inventory reports differing hashes as **ancestry unknown**;
  preparation performs the actual ancestry check in the new clone.
- Managed and local builds currently require **POSIX** for process-group termination.
  Escape/shutdown cancels pending work, terminates the command group, and waits
  for cleanup before finishing, including when Pi shuts down. Detached/unmanaged descendants are unsupported;
  trusted scripts must not daemonize or detach workers.
- State uses revisions, per-package exclusive lock files and atomic replacement.
  A stale preview never overwrites another session's activation. No operation is
  replayed automatically after an uncertain failure: reread state first.

## Store, logs and recovery

The store contains a format marker, package `state.json`, `releases/<UUID>` and
`logs/<UUID>.log`. Managed paths and state are not a secret boundary. Downloaded
code has ordinary user permissions and can access the rest of the system.

Preparation logs combine stdout/stderr, are owner-only and capped at 8 MB. They
may contain sensitive application diagnostics. **View last preparation log**
shows a bounded recent tail privately, including failed/cancelled attempts.
Failed preparations remove only their new staging release; active/prepared
versions are preserved. An interrupted process may leave an orphan release or
`.lock`; this never authorizes automatic activation or retry.

There is no garbage collection or automatic stale-lock deletion. `.lock` is an
append-only JSON Lines journal: an owner PID/start time, then command PID/PGID,
executable, cwd and start time receipts. Each detached wrapper waits for its receipt
to be written and synced before launching package code; parent death before that
gate exits the wrapper without starting the command.

A dead owner PID alone does **not** prove the lock is stale: detached builds can
outlive Pi after SIGKILL/OOM. Verify that the owner and **every recorded process
group** have stopped, checking start times, executable/cwd and group members
(e.g. with `ps -eo pid,ppid,pgid,lstart,args`). PIDs may be reused; never kill a
process based only on its numeric ID. Inspect surviving groups, terminate or let
them finish, then verify again before manually removing the package's `.lock`.
If the journal is incomplete/corrupt or ownership is uncertain, do not unlock
until an operator has established that no preparation code remains. Never remove
a live lock. Preserve all
releases referenced by state or still used by any running session; shut services
down before manually reclaiming unreferenced directories. Store source identity
cannot be silently changed—use a new package ID for an unrelated source/branch.

## Validation

Run `npm run check`, `npm test`, and `npm run build`. The inventory case covers
read-only checks and Git/manifest guards. One focused lifecycle case exercises
real temporary Git repositories and MCP services, npm subprocess wiring, prepare/
activate/rollback isolation, stale revisions, dirty/divergent checkouts, validation
failure/log retention, lock contention, durable process-group receipts/gated
execution, process-group cancellation and operator
confirmation/decline. A focused local-checkout case covers fast-forward/build
reuse, missing outputs, explicit eligibility, dirty/feature/filter refusals,
locking, validation failure recovery, stale-launch guards and cancellation.
Tests do not install into personal directories.

Visual checks use Xvfb, private D-Bus and temporary Pi HOME/profile/project/store.
Never use production task databases/workers as test fixtures.
