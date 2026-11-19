# herdr-openshell

[![CI](https://github.com/leszek-niewiadomski/herdr-openshell/actions/workflows/ci.yml/badge.svg)](https://github.com/leszek-niewiadomski/herdr-openshell/actions/workflows/ci.yml)

Runs herdr worktrees in [NVIDIA OpenShell](https://docs.nvidia.com/openshell/) sandboxes (microVMs): one per worktree, or one shared by all worktrees of a space. Each herdr space (repo) is mapped to an OpenShell workspace, and that workspace decides which credentials the agents get.

| herdr     | OpenShell                     | holds                                                  |
|-----------|-------------------------------|--------------------------------------------------------|
| host      | gateway (`compute_driver=vm`) | driver settings: `vcpus`, `mem_mib`, image cache       |
| space     | workspace                     | providers (credentials), invisible to other workspaces |
| worktree  | sandbox, or a clone in the space's shared sandbox | a git clone of the branch, the agent process |

The worktree is never mounted into the VM. It is copied in as a `git bundle`, and the work comes back the same way.

## Setup

Needs Node.js 22 or later and git on the host.

```sh
curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh
brew install e2fsprogs          # macOS: the VM driver formats disks with mkfs.ext4
cat > ~/.config/openshell/gateway.toml <<'EOF'
[openshell]
version = 2

[openshell.gateway]
compute_driver = "vm"

[openshell.drivers.vm]
vcpus = 2
mem_mib = 4096                  # per sandbox; every running VM costs this much
EOF
brew services restart nvidia/openshell/openshell

herdr plugin install leszek-niewiadomski/herdr-openshell   # or, from a clone: herdr plugin link "$PWD"
```

## Spaces and credentials

Create one OpenShell workspace per credential boundary. Give providers the same names in every workspace, so the configs can refer to `github` without knowing which account sits behind it.

A fresh gateway has no provider profiles (the definitions behind `--type`), so import the ones you use first. They hold no secrets, so importing them `--global` once covers every workspace. The upstream `claude-code` and `github` profiles match the default image's binary paths (`/usr/local/bin/claude`, `/usr/bin/git`, `/usr/bin/gh`); if you use another image, copy and edit their `binaries` instead.

```sh
B=https://raw.githubusercontent.com/NVIDIA/OpenShell/v0.1.7/providers
openshell profile import --global --url $B/claude-code.yaml
openshell profile import --global --url $B/github.yaml
openshell workspace create --name work
```

Providers are created on first use. When a sandbox needs a provider that the workspace lacks, the plugin creates it from your environment, using the variables the profile declares: `GITHUB_TOKEN`/`GH_TOKEN` for `github`, and `ANTHROPIC_API_KEY`/`CLAUDE_API_KEY` for `claude` (profile `claude-code`). A variable missing from herdr's own environment is also looked up in your login shell (`$SHELL -lic`), because herdr may run under launchd without your rc files. A space config can change this with `"credentials"`:

```json
{ "workspace": "work", "providers": ["github", "claude"], "credentials": { "github": "WORK_GITHUB_TOKEN" } }
```

Map a provider to a different host variable, as above, or set `"credentials": false` to never create providers, so they must already exist (`openshell provider create --workspace <ws> ...`). Only the providers listed in your space config are created this way. A provider that a repo's `.openshell/sandbox.json` adds must already exist. Once a provider exists, the plugin never touches it, so rotate a token with `openshell provider update`.

The upstream `github` profile allows clone and fetch but denies push, and read-only API access. That suits this plugin, which brings work back with `pull`. To let agents push, use your own copy of the profile.

Then tell the plugin which repos belong to which workspace. Two ways, checked in this order:

**1. A folder config (recommended).** Put `.herdr-openshell.json` in a folder that holds repos, for example `~/src/work`. It applies to every repo under that folder, whatever its `origin`. The nearest file above the repo wins. The plugin only looks in folders above the repo, never inside it, and only inside `$HOME`.

```json
{ "workspace": "work", "sandbox": "space", "providers": ["github", "claude"], "agent": "claude" }
```

**2. The plugin config,** `$(herdr plugin config-dir herdr-openshell)/config.json`, for repos that aren't grouped by folder. `match` is a prefix of the normalized `origin` URL. The first match wins:

```json
{
  "gateway": "openshell",
  "spaces": [
    { "match": "github.com/acme/", "workspace": "work", "providers": ["github", "claude"] }
  ]
}
```

Repos that match neither are left unsandboxed. A space (in either form) can also set `gateway`, `image`, `agent`, `setup`, and `credentials`. Ready-made folder configs: [`examples/folder.worktree.json`](examples/folder.worktree.json) (one VM per worktree) and [`examples/folder.space.json`](examples/folder.space.json) (one VM per space).

### One VM per worktree or per space

`"sandbox"` in a space config picks how many VMs that space uses. Only your own config files can set it; a repo can't.

| value                  | VMs                                  | clone path in the VM           | tradeoff                                                                                       |
|------------------------|--------------------------------------|--------------------------------|------------------------------------------------------------------------------------------------|
| `"worktree"` (default) | one per worktree                     | `/sandbox/<repo>`              | agents in different worktrees can't touch each other; `mem_mib` per worktree                    |
| `"space"`              | one per repo, shared by its worktrees | `/sandbox/<repo>/<worktree>`  | one VM's memory for the whole repo; agents in the same repo can read and change each other's clones |

In `"space"` mode the VM is created from the first worktree's settings (image, providers, policy). It is deleted only when its last worktree is released. `stop` stops it for every worktree of the space. Changing the mode affects new worktrees only; existing ones keep the sandbox they were created with.

## Repo config (`.openshell/` in the repo root)

The plugin reads these files from `origin/HEAD`, or from the main checkout's `HEAD` when there is no `origin/HEAD`. It never reads them from the worktree. That way an agent cannot widen its own policy or provider list by committing to its branch.

- `.openshell/sandbox.json`: `image`, `providers`, `agent` (the command run by the *agent* action, default `claude`), and `setup` (runs once in the clone after provisioning). These override the space defaults. The workspace always comes from your user config.
- `.openshell/policy.yaml`: the [sandbox policy](https://docs.nvidia.com/openshell/latest/how-it-works/policies/schema). Without it, `default-policy.yaml` applies: no network except the rules that attached providers add.

The default image is `ghcr.io/nvidia/openshell-community/sandboxes/base`, which ships git, claude, codex, and opencode. That image's built-in policy is rejected by OpenShell 0.1.7, which is why the plugin always passes `--policy`.

## Lifecycle

Both herdr clients drive the same script. The herdr terminal app gets the plugin (`herdr-plugin.toml`): its hooks and actions. Herdr.app gets the [`openshell-status` mod](#herdrapp), which shows the sandbox and runs the same actions in a terminal.

| trigger                     | effect                                                                                                                        |
|-----------------------------|-------------------------------------------------------------------------------------------------------------------------------|
| `worktree.created` (herdr)  | creates the sandbox (or reuses the space's), clones the branch into it, sets `origin` to HTTPS and the git identity, then runs `setup`. Herdr.app has no such event: there the first `agent`/`shell` does this. |
| action `agent` / `shell`    | opens a split running `openshell sandbox exec --tty` in the clone. A missing sandbox or clone is created first; a stopped sandbox is started. |
| action `pull`               | fetches the clone's branches into `refs/openshell/<worktree-id>/*` and fast-forwards the current branch if the worktree is clean. |
| action `stop`               | stops the VM. The disk is kept and the next `agent`/`shell` starts it again.                                                  |
| action `delete`             | asks for confirmation (`discard` if work is unpulled), then removes this worktree's clone. The VM is deleted when no other worktree uses it. |
| `worktree.removed` (herdr), or `gc` (Herdr.app, every 10 minutes) | the same as `delete` if everything is pulled. Otherwise it keeps the clone, stops the VM unless other worktrees use it, and sends a notification with the command that deletes it. |

Only committed work comes back. `pull` lists uncommitted files left in the sandbox but does not copy them.

Example keybindings for `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+alt+a"
type = "plugin_action"
command = "herdr-openshell.agent"

[[keys.command]]
key = "prefix+alt+p"
type = "plugin_action"
command = "herdr-openshell.pull"
```

The log is in `$HERDR_PLUGIN_STATE_DIR/plugin.log` (`~/.local/state/herdr/plugins/herdr-openshell/`). One record per worktree (`<worktree-id>.json`) is kept next to it.

The same actions work from any shell, for the worktree containing the folder (default: the current one). A removed worktree's kept sandbox is still found by its old path:

```sh
node herdr-openshell.mjs run agent|shell|pull|stop|delete [dir]
node herdr-openshell.mjs status [dir]   # JSON: workspace, sandbox, clone path, phase
node herdr-openshell.mjs gc             # worktree.removed for every checkout that's gone
```

## Herdr.app

[Herdr.app](https://herdr.dev) doesn't run herdr plugins, so `herdr-app/openshell-status` brings the plugin there as a mod. It replaces the app's status bar with one that shows the focused terminal's sandbox (`workspace / sandbox · ready`, `stopped`, `not created`, or `unreachable` when the gateway is down; hover for the clone's path). Click it for the actions, which open in a terminal beside or below the focused one, like the plugin's panes. Every 10 minutes it runs `gc` in place of the missing `worktree.removed` event.

The mod runs `herdr-openshell.mjs` from this repo, which it finds through its own folder, so install it as a symlink:

```sh
ln -s "$PWD/herdr-app/openshell-status" ~/.config/herdr-app/mods/openshell-status
herdr-app check ~/.config/herdr-app/mods/openshell-status
herdr-app do layout.clone '{"name":"main","as":"openshell"}'
```

Then, in `~/.config/herdr-app/layouts/openshell.json`, change the `status` block's `"mod": "workspace-status"` to `"openshell-status"`. Edits apply live. Keys go in `~/.config/herdr-app/keys.json` (editing it stops Herdr from adding new default shortcuts to it):

```json
"layout:openshell": { "cmd-alt-a": "openshell-status.agent", "cmd-alt-p": "openshell-status.pull" }
```

The mod is a copy of the shipped status bar with the sandbox added, because mods can't import or embed each other. When Herdr changes its own bar, this one won't follow until it is updated here.

You can run both clients: they share the state folder, and a lock per sandbox keeps them from acting on the same VM at once.

## Limits

- The VM driver ignores per-sandbox `--cpu`/`--memory`. `vcpus`/`mem_mib` apply to every sandbox on the gateway.
- `git bundle` carries the full history of the branch, once per worktree even in `"space"` mode. On very large repos provisioning is slow and a shared VM stores the history once per clone.
- Locally, without OIDC, every user is a Platform Admin, so workspaces keep *your* identities apart. To separate teammates, use a shared gateway with OIDC and workspace memberships.

## Development

```sh
node --test                       # status resolution and config trust rules, no gateway needed
node herdr-openshell.mjs status . # what the status bar would show for this folder
```

CI runs the tests on Linux and macOS. To release, bump `version` in `herdr-plugin.toml`, add a `CHANGELOG.md` section, and push a `vX.Y.Z` tag. The release workflow checks that the tag matches the manifest and publishes the changelog section.

## License

[MIT](LICENSE)
