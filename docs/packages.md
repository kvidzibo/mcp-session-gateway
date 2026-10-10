# Package inventory and management contract

The gateway separates three concerns:

- **Packages:** installation identity and update source, independent of MCP.
- **Services:** existing `mcpServers` commands, arguments, environment and cwd.
- **Service settings/UI:** discovered from a running service through the
  [settings](settings.md) and [native UI](native-ui.md) protocols. The manager
  never searches package folders for service configuration files.

Version 0.8 adds **read-only inventory**, not an installer. No service changes,
package updates, restarts, startup network checks, or automatic notifications occur.
No package manifest specific to this gateway is required. Standard MCP servers
need not implement either UI protocol to appear in the inventory.

## Configuration

Keep existing launch entries; optionally add `packages` and link services with
`package`. Several services can reference one package; unlinked packages can also
be inspected. Existing configurations work unchanged.

```json
{
  "packages": {
    "example": {
      "source": { "type": "npm", "name": "@vendor/example-mcp", "tag": "latest" },
      "installedPath": "/opt/services/node_modules/@vendor/example-mcp"
    },
    "worker": {
      "source": {
        "type": "git",
        "url": "https://github.com/vendor/worker.git",
        "branch": "main"
      },
      "installedPath": "/opt/services/worker"
    },
    "development": {
      "source": { "type": "local", "path": "./development-service" }
    }
  },
  "mcpServers": {
    "example": {
      "package": "example",
      "command": "node",
      "args": ["/opt/services/node_modules/@vendor/example-mcp/server.js"]
    },
    "other": { "command": "other-mcp" }
  }
}
```

Package IDs use lowercase letters, digits and hyphens, starting with a letter.
At most 128 packages are allowed. Source and package objects reject unknown keys;
service package references must exist. Paths resolve relative to the gateway
configuration file; use absolute paths when sharing it. Local sources use
`source.path`, not `installedPath`.

`installedPath` is optional for npm/Git. Omitting it means **installed version
unknown**, not "not installed". It is an explicitly declared installation, not
proof that the service command launches that copy. No PATH lookup, global npm
scan, `--version` execution, service-config inspection, or installation happens.
The gateway does not rewrite commands to match these paths.

### Source adapters

| Source | Local inspection | Explicit remote check |
|---|---|---|
| `npm` | `installedPath/package.json`; name must match and version must be valid semver | Public `registry.npmjs.org`, specified dist-tag (default `latest`) |
| `git` | Repository-root HEAD and dirty state, including untracked files | Public HTTPS repository, exact configured branch via `git ls-remote` |
| `local` | Folder existence; optional `package.json` version | None; externally managed |
| Service without `package` | None | None; externally managed |

Npm/Git are **tracked sources**, not gateway-owned installations yet. A package
can be non-Node: Git uses commit IDs; local folders work without `package.json`.
No package code or lifecycle scripts run during inspection. Manifests must be
regular files (not symlinks/devices/FIFOs), limited to 256 KB; reads enforce the
limit even if the file grows after opening.

Initial limits: public npm registry only; public HTTPS Git URLs without embedded
credentials, query or fragment; branch tracking only (no tags/commit pins).
URLs containing backslashes, whitespace or control characters are rejected;
Git receives the validated canonical URL to avoid parser differences.
No `.npmrc`, authentication setup, SSH, or private registries are consumed.
Git **2.45+** is required for Git inspection. Every Git command uses
`--no-lazy-fetch`: partial-clone metadata cannot silently fetch missing objects,
and older Git fails closed rather than ignoring an unfamiliar environment flag.
Git checks suppress credential helpers, askpass programs, terminal prompts, hooks,
fsmonitor and optional index writes. Git subprocess home-directory and netrc
lookups point to the null device, not your personal authentication files.
They do not fetch,
checkout, install, build, or change remote-tracking refs. Dirty-state inspection
is skipped when clean/process filters are configured, since `git status` can run
them. Submodule contents are not inspected. Configuration and local repositories
must still be trusted and not adversarially changed during inspection; these checks
are not a sandbox.

## Pi status screen

Load the normal Pi gateway adapter with `--gateway-config`, then open
**`/gateway-manager`**. This operator screen is not a model tool, sends no model
messages, and needs no service-specific extension. It can inspect configuration
even if a child service failed to start.

- Opening the screen or **r** reads local metadata only. Reopen to reread config.
- **c** explicitly checks all configured npm/Git sources (up to four concurrent).
  This contacts the registry/repositories in your configuration. Each remote
  operation has a ten-second timeout and bounded output.
- **↑/↓**, **PgUp/PgDn** scroll; **Escape** closes and cancels pending checks.
- Results are session-local to the open screen, not persisted or polled. Refresh
  clears previous results; successful checks display a UTC timestamp. Shutdown
  and `/reload` close the screen and cancel pending checks.

The display reports declared installed versions, **not running service versions**.
A newer npm target is "Update available"; a lower target is "Installed newer than
target", never a suggested upgrade. Git shows "Remote differs (ancestry unknown)"
because a changed hash is not proof of a safe fast-forward. Dirty checkouts are
flagged separately. Unknown local versions and failed remote checks remain explicit;
one package failure does not prevent other results.

## Next management stage (not implemented)

Approved updates should use source-specific adapters, not service-specific code:
show exact changes, stage/build/validate separately, reject dirty or divergent Git
updates, and retain the previous runnable installation where possible. Installation
ownership, locks across Pi sessions, build commands, and activation/rollback need
an explicit contract before write actions are introduced. Treat build commands as
trusted executable code, not harmless metadata.

**Updating an installation and restarting a service are separate approvals.**
A shared installation can affect future launches in several sessions; a running
worker must not be silently interrupted. Adding/removing/enabling services and
opening their settings/UI from this menu are also follow-up work. Pi's own
extension-package manager remains separate; this contract tracks MCP service
packages and does not modify Pi settings or load extensions.

## Validation

Run `npm run check`, `npm test`, and `npm run build`. The package inventory test
uses temporary installations and mocked registry metadata, verifies local-only
opening, version comparison, failed/unknown metadata, cancellation and rendering,
rejects executable Git filters and non-regular/oversized manifests, and verifies
Git lazy-fetch/askpass/netrc guards and fail-closed behavior with older Git.
For visual checks use an isolated Pi profile and project under Xvfb with private
D-Bus; never point test launch commands at your normal task database or workers.
