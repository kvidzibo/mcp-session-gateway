# Generic package management

The gateway separates **package sources/installations**, **MCP service launch
configuration**, and **service-owned settings/UI**. It never scans package folders
for service configuration or imports package-specific management code.

The Pi adapter's `/gateway-manager` handles inventory and explicitly confirmed
preparation, activation, rollback and restart. These are operator actions, not
model tools or messages. No automatic updates, builds, activation or restart occur.

## Git main: managed configuration

Use a Git source tracking `main` (also the default). The manager clones its own
copies; it never adopts, pulls into, or rewrites an existing development checkout.

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
  expression. `packageRoot` placeholders are rejected on external services.
- Before first activation a managed service stays stopped, so the manager remains
  usable to install it. An invalid state/missing active directory fails closed.

## Workflow

1. Open **`/gateway-manager`**. Inventory reads local metadata only; **c** checks
   public sources, **r** refreshes locally. Arrow/Page keys scroll, Escape closes.
2. Press **p**, select a managed package, then **Check source and prepare
   install/update**. Approve the exact pinned target and command list.
3. The manager downloads into a new release directory, builds, and runs every
   validation command. It publishes the prepared release only on success. Git
   requires a clean active checkout and a fast-forward ancestry relationship;
   changed HEAD, divergence and an upstream branch moving since preview all fail
   closed. Build output must be ignored by Git, not dirty tracked/untracked source.
4. Separately choose **Activate prepared version** and confirm. This atomically
   changes the version used by **future launches in all sessions sharing the
   store**. Existing processes continue using their old directories.
5. To apply it to this session, return to inventory, press **s**, and confirm
   **Restart gateway services**. It restarts **all children of this gateway**,
   not a selected child. Other Pi sessions are not restarted. Parent agent turns
   must be idle; background job count is unknown. The explicit warning states that
   active/queued jobs will be cancelled—finish them first or decline.

Restart previews the old gateway's launch-snapshot service names separately from
newly configured launches, so editing/removing a config entry cannot hide a child
that will be stopped. The gateway advertises that snapshot in its private
`gateway-services-v1` experimental capability; without it managed restart is
unavailable. Restart uses the configuration and active versions at startup, which
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

Without `managed`, existing read-only inventory remains unchanged:

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
inspection occurs. Unlinked services/local folders remain externally managed.
A `package` reference links inventory but does not prove an external command
launches that installation. Several services may link to one package.

Package IDs use lowercase letters, digits and hyphens, starting with a letter;
at most 128 are allowed. Source/package objects reject unknown keys and service
references must exist. All unchanged `mcpServers`/legacy `servers` entries continue
to work. Pi's own extension-package manager is separate; this manager does not
edit Pi settings, load extensions, register new services or enable/disable entries.
Edit configuration explicitly and reload to change that wiring.

## Checks and safety limits

- Public npm registry only; public HTTPS Git branch sources only. No SSH, private
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
- Managed builds currently require **POSIX** for process-group termination.
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

There is no garbage collection or automatic stale-lock deletion. After verifying
that the recorded PID and its command group have stopped, an operator can remove
that package's stale `.lock` manually. Never remove a live lock. Preserve all
releases referenced by state or still used by any running session; shut services
down before manually reclaiming unreferenced directories. Store source identity
cannot be silently changed—use a new package ID for an unrelated source/branch.

## Validation

Run `npm run check`, `npm test`, and `npm run build`. The inventory case covers
read-only checks and Git/manifest guards. One focused lifecycle case exercises
real temporary Git repositories and MCP services, npm subprocess wiring, prepare/
activate/rollback isolation, stale revisions, dirty/divergent checkouts, validation
failure/log retention, lock contention, process-group cancellation and operator
confirmation/decline. It does not install into personal directories.

Visual checks use Xvfb, private D-Bus and temporary Pi HOME/profile/project/store.
Never use production task databases/workers as test fixtures.
