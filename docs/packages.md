# Generic package management

The gateway keeps **package installations**, **service launch configuration**, and
**service-owned settings/UI** separate. It neither scans packages for service
configuration nor imports package-specific management code.

In the Pi adapter, **`/gateway` → Packages** provides inventory, preparation, activation
and rollback; **Connection** provides restart. These are operator actions, not model
tools or messages. Updates are manual unless explicitly enabled.

[Managed Git setup](#git-main-managed-configuration) · [Workflow](#workflow) · [Update
all](#update-all-packages) · [Startup updates](#automatic-startup-updates) · [Local
Git](#local-git-packages) · [npm/external](#npm-and-external-sources) ·
[Safety](#checks-and-safety-limits) · [Recovery](#store-logs-and-recovery)

## Git main: managed configuration

Git sources track `main` by default. The manager clones its own copies; it never adopts
development checkouts. For in-place updates, configure [local
packages](#local-git-packages).

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

Replace the URL, commands and entry point with the service's instructions.
`gateway.managed.example.json` is a template, not an installable demo. No
gateway-specific manifest is needed. Non-Node packages also work: a declared `uv sync
--locked` step can create a project-local Python environment.

### Store and commands

| Setting | Rules |
|---|---|
| `packageStore` | Defaults to `.gateway-packages` beside the config; relative paths resolve there, not Pi's cwd. Keep it out of Git. Sessions sharing a store share activation state and per-package write locks. |
| `managed` | Opts into gateway-owned copies; incompatible with `installedPath` or local sources. Existing folders are never migrated automatically. |
| `build` / `validate` | Build is optional; validation requires at least one command. Use executables and literal arguments, **not shell strings**. |
| Command `cwd` | Defaults to the package root; subdirectories such as `pi` must resolve inside it. |
| `timeoutMs` | Per-command timeout: default five minutes, maximum one hour. |

Preparation previews the complete source, pinned version, commands, store and effects.
Review every line before Enter confirms. **Downloaded code and commands run with your OS
permissions, not in a sandbox. Configure only trusted packages and commands.**

Builds receive a private home/cache and minimal PATH/locale environment, not service
credentials or parent-agent API keys. Declare setup in commands; private registries and
credential setup are unsupported.

### Service launches

`{{packageRoot}}` is replaced in linked service commands, arguments, cwd and env at
gateway startup; it is not a shell expression. Managed and explicit `localUpdate`
launches must reference it. Other external services reject it.

Before first activation, managed services stay stopped so the manager remains usable for
installation. Invalid state or a missing active directory fails closed.

## Update all packages

Choose **`/gateway` → Update all packages** for a one-time update, even when Auto update
is off or disconnected. Review all sources, commands and effects, then confirm. Approval
covers resolving the latest configured sources, building, validating and activating;
unlike individual preparation, targets resolve **after approval**. The saved Auto update
setting is unchanged.

| Package | Eligible? |
|---|---|
| Already-activated managed release | Yes, including unlinked declarations |
| Explicit `localUpdate` Git checkout | Yes, including unlinked declarations |
| Inactive managed package | No; first install through **Manage releases** |
| Other external package | No; read-only |

The [startup safeguards](#automatic-startup-updates) also apply: concurrency, clean-tree
checks, locks, validation and cancellation. Escape cancels progress; results retain
completed version changes after cleanup. Package failures, including local failures, do
not stop unrelated manual updates. A local rebuild may succeed without changing version.

Review the [effects on running sessions](#effects-on-running-sessions) first: updates do
not restart services or roll back completed changes. Use **Connection → Restart gateway
services** separately when ready.

## Automatic startup updates

### Enable and authorize

Select **`/gateway` → Auto update: Off/On** to toggle and save the selected config
without another confirmation. This works while disconnected and does not update or
restart services immediately. The label refreshes from disk; save failures report an
error and preserve the previous value. Saving reformats JSON but preserves other values,
including environment references.

Concurrent adapter saves are refused. An interrupted save may leave
`<config>.auto-update.lock`; remove it only after verifying no session is saving.

Alternatively, set top-level `"autoUpdate": true` (default `false`; boolean only). This
authorizes the **Pi adapter**, on startup/reload, to check public sources and prepare,
build, validate and activate changed versions before child startup, **without per-update
confirmation**. It grants ongoing permission to run configured trusted code with your OS
permissions, not in a sandbox. Enable only for trusted sources and commands. `false`
disables startup writes; managed-release operations remain separately confirmed.

### Eligibility and timing

Only service-linked, already-activated managed releases and explicit `localUpdate`
checkouts qualify. First installations, unlinked packages and other external/local
folders remain manual.

The standalone stdio gateway does not run this adapter policy. Manual Connection-menu
restarts do not check for updates. No services connect until all startup updates finish.

### Concurrency and resources

The default concurrency is `min(4, max(1, floor(available CPU cores / 2)))`, using
Node's `availableParallelism()` to respect CPU affinity. Top-level
`"autoUpdateConcurrency"` accepts integers **1–128**, including values above four; `1`
runs sequentially.

The limit counts whole package operations; each package's build/validation steps remain
sequential. Builds/tests may themselves use multiple cores, so higher limits increase
RAM/disk contention. Local checkouts sharing a canonical Git common directory run one at
a time; locks held by other operations are still refused. Summaries retain config order.

### Failures, launch guards and cancellation

Pinned-version, clean-tree, ancestry/downgrade, locking, validation, logging and
cancellation checks still apply. **No same-startup retries.**

| Outcome | Startup behavior |
|---|---|
| Managed-release failure | Warn; retain current activation |
| Refused local update | May warn and use the existing checkout if launch guards pass; dirtiness or a feature branch alone does not block launch |
| Local lock, pending build, stale receipt or missing declared output | Block startup |
| Unchanged local checkout | May skip rebuilding |

Shutdown or a startup-blocking local failure stops queued updates, cancels active
operations and waits for cleanup. Completed changes are not rolled back. [Local build
recovery](#local-build-state-and-recovery) also applies to manual and standalone
launches, even with auto-update disabled.

### Effects on running sessions

**Updates do not restart services. Finish affected jobs in all sessions first.**

| Update | Effect |
|---|---|
| Managed activation | Changes future launches for all sessions sharing the store |
| Local Git update | Immediately changes shared files, dependencies and outputs that running services may read |

Completed changes are not rolled back. Apply new versions here through **Connection →
Restart gateway services** when ready.

### Progress and results

During initial startup/reload, the animated loader names each service being checked.
**Updating service <name>** covers preparation, build, validation and activation. Local
first-time validation and missing-output rebuilds also show this stage; fully current
services show only checking. With concurrency, the loader shows the latest progress
event, not every active operation.

After successful version changes, one display-only chat entry says **MCP servers were
updated**, listing package IDs and old/new versions. It never starts a model turn. No
entry appears when up to date, disabled, ineligible or entirely failed.
Initial/output-only builds do not claim version updates.

## Local Git packages

Declare the existing Git root, enable `localUpdate`, and explicitly link its service.
Repositories are never inferred from executables, cwd or arguments. Plain local sources
remain read-only inventory.

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

### Checkout and remote requirements

- `source.path` resolves relative to the gateway config and must be a Git root. Use one
  package per checkout; multiple services may link to it. `localUpdate` cannot accompany
  `managed` or `installedPath`.
- Updates require a clean, attached **main/master** branch tracking the same branch on a
  public remote. The updater fetches the exact upstream ref and fast-forwards to its
  pinned commit. It never resets, stashes, rebases, force-pulls or switches branches.
- Dirty, ahead/diverged, feature/detached branches, executable Git filters and
  submodules are refused for updating; nothing is automatically repaired. Update refusal
  is distinct from the [launch guards](#failures-launch-guards-and-cancellation).
- HTTPS remotes are supported. GitHub `git@github.com:owner/repo.git` and
  `ssh://git@github.com/owner/repo.git` are checked over public HTTPS without SSH or
  credentials. Private repositories and other SSH remotes are unsupported.

### Build reuse and outputs

Declare commands explicitly; package scripts are not inferred. Include dependency setup
(`npm ci`, `uv sync --locked`, etc.) when needed. All steps run:

- After a pull or on the first enabled startup.
- When commands change or a declared `outputs` path is missing.

Otherwise builds are reused. `outputs` is optional; include `node_modules` or `.venv` if
their absence should trigger setup. Outputs are not content-fingerprinted. Build outputs
must be Git-ignored; steps and outputs must stay inside the root.

`validate` requires at least one command; `build` may be empty. Managed-build rules
apply: minimal environment, private HOME/cache, per-command timeouts and process-group
cleanup; no service env/API credentials. `{{packageRoot}}` binds to the checkout and
must appear in its service launch. Successful version changes use the normal startup
summary.

### Local build state and recovery

The Git directory contains:

| File | Purpose |
|---|---|
| `mcp-gateway-local.json` | Successful HEAD/command receipt or pending-build marker |
| `mcp-gateway-local.log` | Latest bounded operation output |

A marker is written **before files change**. Failed builds/validation do not roll back
developer files: startup stops rather than launching stale output. Earlier package
updates may already have applied; there is no cross-package rollback.

Manual/standalone launches also reject pending builds, changed receipts or missing
declared outputs, even with auto-update disabled. Inspect the log, fix the failure, then
reload with auto-update enabled to retry the build. **Do not delete receipts.**

A common-Git-directory `mcp-gateway-local.lock` serializes sessions and worktrees. It
uses the same durable owner/process-group journal and [stale-lock
recovery](#store-logs-and-recovery) as managed packages. Never delete a live lock.

Local packages have no individual release, activation or rollback UI. Use startup
updates or **Update all packages**, after reviewing [shared-file
effects](#effects-on-running-sessions).

## Workflow

1. Open **`/gateway` → Packages**. **Installed versions** reads local metadata; **Check
   for updates** contacts public sources. In the version view, **r** refreshes locally,
   Arrow/Page keys scroll, and Escape goes back.
2. Select **Manage releases → package → Check source and prepare install/update**.
   Approve the exact pinned target and commands.
3. Preparation downloads into a new release directory, builds and runs every validation
   command; only success publishes the prepared release. Git requires a clean active
   checkout and fast-forward ancestry. Changed HEAD, divergence or an upstream branch
   moving since preview fails closed. Build outputs must be Git-ignored, not dirty
   tracked/untracked source.
4. Select **Activate prepared version** and confirm. This atomically changes **future
   launches in every session sharing the store**; existing processes keep their old
   directories.
5. When ready, select **Gateway → Connection → Restart gateway services…** and confirm.
   This restarts **all this gateway's children**, not one selected child or other Pi
   sessions. Parent-agent turns must be idle; background job count is unknown.
   **Active/queued jobs will be cancelled—finish them first or decline.**

### Restart behavior

Restart previews the old gateway's launch-snapshot service names separately from newly
configured launches: editing/removing config cannot hide children being stopped.
Connected restart requires the private `gateway-services-v1` experimental capability
advertising that snapshot. Disconnected gateways can still be explicitly started for
recovery.

Restart uses configuration and active versions at startup, possibly changed by another
session. The gateway UUID changes; saved native UI conversation/branch selection is
restored. Failure leaves the connection stopped: explicitly roll back and restart, with
no automatic retries or fallback.

### Rollback and retained releases

**Rollback** separately confirms switching future launches to the previous active
release. It discards any prepared candidate, checked against a different active base,
but retains its files. Rollback does not restart processes, rebuild code or reverse
external data migrations.

Old release directories remain usable by existing processes and previous versions. Keep
persistent application data outside them. Builds run in their final location;
directories are never renamed afterward, preserving absolute virtual-environment paths.

## npm and external sources

### Managed npm

Replace `source` with:

```json
{ "type": "npm", "name": "@vendor/example-mcp", "tag": "latest" }
```

The tag defaults to `latest`. Preparation pins the resolved semver and runs `npm install
--ignore-scripts` in a new private prefix. Dependency lifecycle scripts are disabled;
explicitly declare trusted commands such as `npm rebuild` if needed. `packageRoot` is
the installed package directory, not the prefix. Validation must suit published
contents, which may omit development/test files. Lower npm targets are refused; use the
separately approved previous-release rollback to switch back.

### Read-only inventory

Without `managed` or `localUpdate`, existing inventory remains read-only:

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

npm/Git installations may declare `installedPath`; omission means unknown version, not
necessarily absent. Local sources use `source.path`. No PATH/global-npm scan,
`--version` execution or service-settings inspection occurs. Local folders without
`localUpdate` remain externally managed. Unlinked `localUpdate` declarations are skipped
at startup but qualify for confirmed **Update all packages**.

A `package` reference links inventory, not proof that an external command launches that
installation. Multiple services may link to one package.

### Configuration constraints

Package IDs use lowercase letters, digits and hyphens, starting with a letter; at most
128 packages are allowed. Source/package objects reject unknown keys; service package
references must exist. Unchanged `mcpServers`/legacy `servers` entries continue working.

Pi's extension-package manager is separate. This manager does not edit Pi settings, load
extensions, register services or enable/disable entries. Edit configuration explicitly
and reload to change that wiring.

## Checks and safety limits

### Sources and metadata

- Public npm registry and public HTTPS Git branches only, with local GitHub SSH
  normalization as above. No authenticated SSH, private registries, embedded URL
  credentials, tags or commit-pin source declarations. URLs reject whitespace,
  backslashes and control characters; Git receives the canonical validated URL. Package
  management requires no service UI protocol.
- **Git 2.45+** is required for `--no-lazy-fetch` metadata commands; older Git fails
  closed. No implicit partial-clone fetches, credential helpers, askpass, personal
  netrc, hooks, fsmonitor or optional index writes. Metadata checks never fetch,
  checkout or build; confirmed preparation is the download/build path.
- Clean/process filters prevent read-only dirty inspection; lifecycle actions reject
  those checkouts rather than execute filters. Submodules are not inspected or
  initialized automatically. Trust repositories/config and do not change them
  adversarially during operations.
- Metadata manifests must be regular files, not symlinks/FIFOs/devices. Reads verify the
  opened handle and enforce a **256 KB** cap. Source checks are bounded, cancellable and
  limited to **four** concurrent operations; each remote metadata request has a
  **ten-second** timeout.
- Versions describe declared installations, not running processes. npm identifies
  newer/older targets; differing Git hashes mean **ancestry unknown** until preparation
  checks ancestry in the new clone.

### Processes and state

- Managed/local builds require **POSIX** process-group termination. Escape/shutdown
  cancels pending work, terminates command groups and waits for cleanup, including Pi
  shutdown. Detached/unmanaged descendants are unsupported; trusted scripts must not
  daemonize or detach workers.
- Revisions, per-package exclusive locks and atomic replacement protect state. Stale
  previews cannot overwrite another session's activation. Uncertain failures are never
  automatically replayed: reread state first.

## Store, logs and recovery

### Layout and logs

The store contains a format marker, package `state.json`, `releases/<UUID>` and
`logs/<UUID>.log`. Managed paths/state are not a secret boundary; downloaded code has
ordinary user access to the system.

Preparation logs combine stdout/stderr, are owner-only and capped at **8 MB**; they may
contain sensitive diagnostics. **View last preparation log** privately shows a bounded
recent tail, including failed/cancelled attempts.

Failed preparations remove only their new staging release, preserving active and
prepared versions. Interruptions may leave orphan releases or `.lock` files; these never
authorize automatic activation or retry. There is no garbage collection or automatic
stale-lock deletion.

### Durable lock journal

`.lock` is an append-only JSON Lines journal recording owner PID/start time, then
command PID/PGID, executable, cwd and start time. Each detached wrapper waits for its
receipt to be written and synced before launching package code. Parent death before that
gate makes the wrapper exit without launching the command.

### Recover a stale lock

A dead owner alone **does not prove staleness**: detached builds may outlive Pi after
SIGKILL/OOM.

1. Inspect the owner and **every recorded process group**, including start times,
   executable/cwd and group members, for example with `ps -eo
   pid,ppid,pgid,lstart,args`. PIDs can be reused; **never kill by numeric ID alone**.
2. Inspect surviving groups; terminate them or let them finish, then verify again that
   the owner and all recorded groups have stopped.
3. Only then manually remove the package's `.lock`. If the journal is incomplete,
   corrupt or ownership uncertain, do not unlock until an operator establishes that no
   preparation code remains. **Never remove a live lock.**

Preserve releases referenced by state or used by any running session. Shut services down
before manually reclaiming unreferenced directories. Store source identity cannot
silently change; use a new package ID for an unrelated source/branch.

## Validation

Run `npm run check`, `npm test`, and `npm run build`.

Tests cover read-only inventory, isolated prepare/activate/rollback, Git and launch
guards, build reuse, failure recovery, durable locks, process cleanup and operator
confirmations using temporary repositories/services.

Tests do not install into personal directories. Visual checks use Xvfb, private D-Bus
and temporary Pi HOME/profile/project/store. **Never use production task
databases/workers as fixtures.**
