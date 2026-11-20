---
name: herdr-openshell
description: Use when working with herdr worktrees that run in NVIDIA OpenShell sandboxes - checking which sandbox a worktree uses, starting or stopping it, running commands in it, bringing commits back, cleaning up, or when you find yourself inside a /sandbox clone.
---

# herdr-openshell

The herdr-openshell plugin runs each herdr worktree's agent in an OpenShell microVM. The worktree is never mounted into the VM: it is copied in as a git clone, and work comes back as git commits through `pull`. Credentials come from the OpenShell workspace mapped to the repo's folder, not from the host.

First work out which side you are on:

- **Inside a sandbox:** your working directory is under `/sandbox/` (for example `/sandbox/app`), the shell prompt reads `sandbox@<name>`, and the host's files are not visible. Read "Working inside a sandbox".
- **On the host:** you can see the real worktree and run `herdr`, `openshell` and `git` against it. Read "Driving sandboxes from the host".

## Working inside a sandbox

- **Your work only comes back as commits.** The host fetches your branches with `pull`. Uncommitted files stay in the VM, so commit before you say you're done.
- **Don't push.** The default `github` provider allows clone and fetch but denies push. The person brings your commits back with `pull`.
- **Network access is denied by default.** Only hosts that the attached providers declare are reachable (for example `api.anthropic.com` and `github.com`). If you see `npm install`, `pip install` or `curl` fail with connection errors, that is the policy, not an outage. Say which host you need; don't try to get around the block.
- **Don't edit `.openshell/` to get more access.** The plugin reads `.openshell/sandbox.json` and `policy.yaml` from the repo's default branch (`origin/HEAD`), never from your branch. Changing them on your branch has no effect on any sandbox.
- **In space mode, other worktrees' clones are siblings.** Paths look like `/sandbox/<repo>/<worktree>`. Stay in your own directory.

## Driving sandboxes from the host

All commands go through the plugin script. To find it:

- **Linked from a clone:** `herdr plugin list` shows the path in `[local:...]`.
- **Installed from GitHub:** it lives in `~/.config/herdr/plugins/github/herdr-openshell-*/`.

```sh
HOS="node /path/to/herdr-openshell/herdr-openshell.mjs"
```

Each command works on the linked worktree that contains `dir` (default: the current directory). A repo's main checkout is never sandboxed.

### See what a worktree uses

```sh
$HOS status [dir]
```

It prints one line of JSON:

| Output | Meaning |
|---|---|
| `{}` | Not sandboxed: a main checkout, not a git repo, or no space config covers it |
| `{"error": "..."}` | A space config is broken; the message names the file |
| `{"workspace", "sandbox", "workdir", "phase"}` | Sandboxed. `phase` is `none` (not created yet), `Ready`, `Stopped`, another OpenShell phase, or `unreachable` (gateway down) |

`status` never creates or starts anything, so it's safe to call often.

### Actions

```sh
$HOS run pull   [dir] </dev/null          # fetch the sandbox's branches, fast-forward if clean
$HOS run stop   [dir] </dev/null          # stop the VM, keep its disk
printf 'y\n\n'       | $HOS run delete [dir]   # remove this worktree's clone (VM too if unshared)
printf 'discard\n\n' | $HOS run delete [dir]   # same, when it holds unpulled work
$HOS run shell  [dir]                     # interactive shell in the clone (needs a TTY)
$HOS run agent  [dir]                     # interactive agent in the clone (needs a TTY)
$HOS gc                                   # handle every worktree whose folder is gone
```

- **`pull`** fetches every branch in the clone into `refs/openshell/<worktree-id>/*`. It fast-forwards the current branch only if the host worktree is clean and the histories haven't diverged. Otherwise it prints the `git merge` to run, and the decision is the person's. It also lists files left uncommitted in the sandbox, which it does not copy.
- **`delete`** asks for confirmation. Answer `y` when everything is pulled, or `discard` when it reports unpulled work. Only send `discard` if the person said that work can go.
- **`stop`** stops the VM for every worktree that shares it (in space mode, all worktrees of the repo).
- **`agent` / `shell`** create the sandbox if it doesn't exist and start it if it's stopped. They need a terminal; don't run them from a non-interactive tool call. For one-off commands, use `openshell sandbox exec` (below).
- **`gc`** prints a JSON array with one message per sandbox it kept because of unpulled work.

### Running a command in a sandbox

Take `workspace`, `sandbox` and `workdir` from `status`:

```sh
openshell sandbox exec --workspace <workspace> <sandbox> --no-tty --workdir <workdir> -- git log --oneline -5
```

The command runs under the sandbox's network policy, so no host secrets reach it. Prefer this over `run shell` when you are an agent.

## Lifecycle

| Event | herdr (terminal) | Herdr.app |
|---|---|---|
| Worktree created | `worktree.created` hook creates the sandbox and clones the branch | nothing; the first `agent`/`shell` creates it |
| Worktree removed | `worktree.removed` hook | the `openshell-status` mod runs `gc` every 10 minutes |
| Actions | plugin actions `herdr-openshell.<action>` | click the sandbox in the status bar, or keys bound to `openshell-status.<action>` |

On removal, a sandbox whose work is all pulled is deleted (only its clone, if other worktrees share the VM). One with unpulled commits or uncommitted files is kept and stopped, and a notification gives the `run delete` command. A kept sandbox stays reachable by its old worktree path, so `$HOS run pull <old path>` still works after the folder is gone.

## Configuration

The person sets these up. Change them only when asked.

- **Space config:** `.herdr-openshell.json` in a folder above the repos (only inside `$HOME`; the nearest one wins). Otherwise, the `spaces` list in `~/.config/herdr/plugins/config/herdr-openshell/config.json`, matched by `origin` URL prefix. Fields:
  - `workspace` (required): the OpenShell workspace, which is the credential boundary.
  - `sandbox`: `"worktree"` (one VM each) or `"space"` (one VM per repo).
  - `providers`, `agent`, `setup`, `image`, `gateway`.
  - `credentials`: a provider-to-env-var map, or `false`.
- **Repo config:** `.openshell/sandbox.json` (`image`, `providers`, `agent`, `setup`) and `.openshell/policy.yaml`. Both are read from the default branch only. A repo can't choose the workspace or the `sandbox` mode.
- **Providers:** when the workspace lacks a provider that the space config lists, the plugin creates it from host env vars: `GITHUB_TOKEN`/`GH_TOKEN` for `github`, `ANTHROPIC_API_KEY`/`CLAUDE_API_KEY` for `claude`. It also falls back to the login shell for these. Never put a token on a command line. Rotate one with `openshell provider update`.

## Troubleshooting

- **Logs:** `~/.local/state/herdr/plugins/herdr-openshell/plugin.log`. The same folder holds one `<worktree-id>.json` record per worktree. `herdr plugin log` shows each hook and action run, with stderr.
- **`provider "github" is missing ... is not set`:** export the variable the message names, or create the provider by hand in that workspace.
- **`unreachable`:** the gateway is down. On macOS run `brew services restart nvidia/openshell/openshell` and check `/opt/homebrew/var/log/openshell/openshell-gateway.err.log`.
- **Stuck in `Provisioning`, or `ProvisioningFailed`:** on macOS, `brew install e2fsprogs`, and check that `~/.config/openshell/gateway.toml` sets `compute_driver = "vm"`.
- **`pull` says the branch diverged:** the host and sandbox both have new commits. Show the person `git log --oneline HEAD...refs/openshell/<id>/<branch>` and let them choose between merge and rebase.
