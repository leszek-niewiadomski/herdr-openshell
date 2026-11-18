#!/usr/bin/env node
// herdr-openshell: one OpenShell sandbox (microVM) per herdr worktree.
//
//   node herdr-openshell.mjs event    worktree.created / worktree.removed hook
//   node herdr-openshell.mjs action   agent | shell | pull | stop | delete (HERDR_PLUGIN_ACTION_ID)
//   node herdr-openshell.mjs pane     session/task pane body (HOS_* env from the action)
//   node herdr-openshell.mjs status [dir] JSON for status bars: the sandbox of the worktree at dir
//
// The checkout is copied in as a git bundle and results come back as a git
// bundle, so no host directory is ever mounted into the VM.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

const env = process.env;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const HERDR = env.HERDR_BIN_PATH || "herdr";
// Fallbacks are herdr's own plugin dirs, so `status` run from outside herdr sees the same state.
const STATE = env.HERDR_PLUGIN_STATE_DIR || path.join(os.homedir(), ".local/state/herdr/plugins/herdr-openshell");
const CONFIG = path.join(env.HERDR_PLUGIN_CONFIG_DIR || path.join(os.homedir(), ".config/herdr/plugins/config/herdr-openshell"), "config.json");
const FOLDER_CONFIG = ".herdr-openshell.json";
const DEFAULT_IMAGE = "ghcr.io/nvidia/openshell-community/sandboxes/base:latest";
fs.mkdirSync(STATE, { recursive: true });

const log = (msg) => fs.appendFileSync(path.join(STATE, "plugin.log"), `${new Date().toISOString()} ${msg}\n`);
const say = (msg) => { log(msg); console.error(msg); };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
  if (r.error) throw r.error;
  return r;
}
function must(cmd, args, opts) {
  const r = run(cmd, args, opts);
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")}: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout || "").trim();
}
const git = (dir, ...args) => must("git", ["-C", dir, ...args]);
const tryGit = (dir, ...args) => { const r = run("git", ["-C", dir, ...args]); return r.status === 0 ? r.stdout.trim() : null; };
const notify = (title, body) => run(HERDR, ["notification", "show", title, "--body", body]);

// --- identity -----------------------------------------------------------------

// Deterministic from a path, so a removed worktree still maps to its record and sandbox.
function idFor(p) {
  const slug = path.basename(p).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
  return `${slug || "wt"}-${crypto.createHash("sha1").update(p).digest("hex").slice(0, 6)}`;
}

// One record per worktree. In "space" mode several records point at the same sandbox (rec.name).
const recordPath = (checkout) => path.join(STATE, `${idFor(checkout)}.json`);
const save = (rec) => fs.writeFileSync(recordPath(rec.checkout), JSON.stringify(rec, null, 2));
const sharers = (rec) => fs.readdirSync(STATE).filter((f) => f.endsWith(".json"))
  .map((f) => readJson(path.join(STATE, f))).filter((r) => r && r.name === rec.name && r.checkout !== rec.checkout);

// git@host:org/repo.git | https://host/org/repo.git -> host/org/repo
const normalizeRemote = (url) => url.replace(/^[a-z+]+:\/\//, "").replace(/^[^@/]+@/, "").replace(/^([^/:]+):/, "$1/").replace(/\.git$/, "");

// A .herdr-openshell.json in a folder above the repo (never inside it) is the space config for
// every repo under that folder. Only folders inside $HOME count, so another local user can't
// plant one in /tmp. A broken file throws instead of silently leaving repos unsandboxed.
function folderSpace(repoRoot) {
  const home = os.homedir();
  for (let d = path.dirname(repoRoot); d === home || d.startsWith(home + path.sep); d = path.dirname(d)) {
    const file = path.join(d, FOLDER_CONFIG);
    if (!fs.existsSync(file)) continue;
    try { return { ...JSON.parse(fs.readFileSync(file, "utf8")), from: file }; } catch (e) { throw new Error(`${file}: ${e.message}`); }
  }
  return null;
}

// Everything a worktree's sandbox needs, resolved once and stored in its record.
// Repo files are read from the trusted ref (origin's default branch), never the worktree,
// so an agent cannot widen its own policy or providers by committing to its branch.
function resolve(checkout, repoRoot) {
  const cfg = readJson(CONFIG) || {};
  const origin = tryGit(repoRoot, "remote", "get-url", "origin") || "";
  const key = normalizeRemote(origin);
  const space = folderSpace(repoRoot) || (cfg.spaces || []).find((s) => key.startsWith(s.match));
  if (!space) return { skip: `no ${FOLDER_CONFIG} above ${repoRoot} and no space in ${CONFIG} matches "${key}"` };
  if (!space.workspace) throw new Error(`${space.from || CONFIG}: space has no "workspace"`);
  const mode = space.sandbox || "worktree"; // isolation level is the user's call, never the repo's
  if (mode !== "worktree" && mode !== "space") throw new Error(`"sandbox" must be "worktree" or "space", got "${mode}"`);

  const ref = tryGit(repoRoot, "rev-parse", "--verify", "-q", "refs/remotes/origin/HEAD") ? "refs/remotes/origin/HEAD" : "HEAD";
  const show = (file) => tryGit(repoRoot, "show", `${ref}:.openshell/${file}`);
  const repoCfg = JSON.parse(show("sandbox.json") || "{}");
  const merged = { image: DEFAULT_IMAGE, providers: [], agent: "claude", setup: "", ...space, ...repoCfg };
  const repo = key.split("/").pop() || path.basename(repoRoot);
  return {
    name: idFor(mode === "space" ? repoRoot : checkout),
    checkout,
    repoRoot,
    workspace: space.workspace, // never from the repo
    gateway: space.gateway || cfg.gateway || "",
    image: merged.image,
    providers: merged.providers,
    // Created from host env vars when missing, but only providers the user's space config lists:
    // a repo naming a new provider must not pull another host secret into the workspace.
    autoProviders: space.credentials === false ? [] : merged.providers.filter((p) => (space.providers || []).includes(p)),
    credentials: space.credentials || {}, // provider -> host env var name, overriding the profile's vars
    agent: merged.agent,
    setup: merged.setup,
    policy: show("policy.yaml") ?? fs.readFileSync(path.join(HERE, "default-policy.yaml"), "utf8"),
    origin: key ? `https://${key}.git` : "", // sandboxes push over HTTPS through a provider, not host SSH keys
    workdir: mode === "space" ? `/sandbox/${repo}/${path.basename(checkout)}` : `/sandbox/${repo}`,
  };
}

// --- openshell ----------------------------------------------------------------

const osArgs = (rec, sub, ...args) => ["sandbox", sub, "--workspace", rec.workspace, ...(rec.gateway ? ["-g", rec.gateway] : []), ...args];
const osh = (rec, sub, ...args) => must("openshell", osArgs(rec, sub, ...args));

function phase(rec) {
  const r = run("openshell", osArgs(rec, "get", rec.name, "-o", "json"));
  if (r.status !== 0) {
    if (/not found/i.test(r.stderr)) return null;
    throw new Error(r.stderr.trim());
  }
  return JSON.parse(r.stdout).phase;
}

// --- providers ----------------------------------------------------------------

const PROVIDER_TYPES = { claude: "claude-code" }; // provider name -> profile, where they differ
const SHELL_MARK = "@@herdr-openshell@@";

// herdr's server can run under launchd without the shell's rc files, so a variable missing
// here is looked up in the user's login shell as well.
function hostEnv(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`bad env var name "${name}"`);
  if (env[name]) return env[name];
  try {
    const out = run(env.SHELL || os.userInfo().shell || "/bin/sh", ["-lic", `printf '%s%s' '${SHELL_MARK}' "$${name}"`],
      { stdio: ["ignore", "pipe", "ignore"], timeout: 15e3 }).stdout || "";
    const i = out.lastIndexOf(SHELL_MARK);
    return i < 0 ? "" : out.slice(i + SHELL_MARK.length);
  } catch { return ""; }
}

function ensureProviders(rec) {
  const g = rec.gateway ? ["-g", rec.gateway] : [];
  const ws = ["--workspace", rec.workspace, ...g];
  withLock(`providers-${rec.workspace}`, () => {
    for (const name of rec.autoProviders || []) {
      if (run("openshell", ["provider", "get", ...ws, name]).status === 0) continue;
      const type = PROVIDER_TYPES[name] || name;
      const creds = JSON.parse(must("openshell", ["profile", "describe", ...ws, type, "-o", "json"])).credentials || [];
      const override = rec.credentials[name];
      if (override && creds.length !== 1) throw new Error(`credentials.${name}: profile ${type} has ${creds.length} credentials, not 1`);
      // The secret goes to openshell through its env, never argv.
      const childEnv = { ...env }, keys = [], used = [];
      for (const c of creds) {
        const from = override ? [override] : c.env_vars;
        const src = from.find((v) => (childEnv[c.env_vars[0]] = hostEnv(v)));
        if (!src) {
          if (!c.required) continue;
          throw new Error(`provider "${name}" is missing in workspace ${rec.workspace} and ${from.join("/")} is not set; ` +
            `set it, or create the provider: openshell provider create --workspace ${rec.workspace} --name ${name} --type ${type} ...`);
        }
        keys.push("--credential", c.env_vars[0]);
        used.push(src);
      }
      say(`creating provider ${name} (${type}) in workspace ${rec.workspace} from ${used.join(", ") || "no credentials"}`);
      must("openshell", ["provider", "create", ...ws, "--name", name, "--type", type, ...keys], { env: childEnv });
    }
  });
}

// Inside the sandbox; vars go in as --env so nothing is interpolated into the script.
const shIn = (rec, script, vars = {}) =>
  osh(rec, "exec", rec.name, "--no-tty", ...Object.entries(vars).flatMap(([k, v]) => ["--env", `${k}=${v}`]), "--", "sh", "-c", script);

function withLock(name, fn) {
  const lock = path.join(STATE, `${name}.lock`);
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 15 * 60e3) fs.rmSync(lock, { recursive: true }); } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

const withTmp = (fn) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-openshell-"));
  try { return fn(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
};

function createSandbox(rec) {
  ensureProviders(rec);
  withTmp((tmp) => {
    const policy = path.join(tmp, "policy.yaml");
    fs.writeFileSync(policy, rec.policy);
    say(`creating ${rec.name} in workspace ${rec.workspace} from ${rec.image}`);
    osh(rec, "create", "--name", rec.name, "--from", rec.image, "--policy", policy, "--detach",
      "--no-auto-providers", ...rec.providers.flatMap((p) => ["--provider", p]));
  });
}

// Clone the worktree's branch into rec.workdir inside the sandbox.
// ponytail: a full bundle per worktree, so a shared sandbox stores history once per worktree;
// fetch into one shared repo + `git worktree add` if that disk use matters.
function addWorktree(rec) {
  withTmp((tmp) => {
    const bundle = path.join(tmp, "repo.bundle");
    const inbox = `/sandbox/.in-${idFor(rec.checkout)}.bundle`;
    const branch = tryGit(rec.checkout, "symbolic-ref", "--short", "-q", "HEAD") || "";
    git(rec.checkout, "bundle", "create", bundle, "HEAD", ...(branch ? [branch] : []));
    osh(rec, "upload", rec.name, bundle, inbox, "--no-git-ignore");
    shIn(rec, [
      'set -e',
      'mkdir -p "$(dirname "$W")"',
      'git clone -q "$IN" "$W" && rm "$IN" && cd "$W"',
      'if [ -n "$B" ]; then git checkout -q -B "$B" "$S"; else git checkout -q --detach "$S"; fi',
      'if [ -n "$O" ]; then git remote set-url origin "$O"; fi',
      'if [ -n "$GN" ]; then git config user.name "$GN"; fi',
      'if [ -n "$GE" ]; then git config user.email "$GE"; fi',
      'if [ -n "$SETUP" ]; then sh -c "$SETUP"; fi',
    ].join("\n"), {
      W: rec.workdir, IN: inbox, B: branch, S: git(rec.checkout, "rev-parse", "HEAD"), O: rec.origin,
      GN: tryGit(rec.checkout, "config", "user.name") || "", GE: tryGit(rec.checkout, "config", "user.email") || "",
      SETUP: rec.setup,
    });
    say(`${rec.name} ready at ${rec.workdir}`);
  });
}

// Create the sandbox if missing, start it if stopped, clone the worktree into it if absent.
function ensure(checkout, repoRoot) {
  const rec = readJson(recordPath(checkout)) || resolve(checkout, repoRoot);
  if (rec.skip) return rec;
  return withLock(rec.name, () => {
    const p = phase(rec);
    if (!p) createSandbox(rec);
    else if (p === "Stopped") {
      say(`starting ${rec.name}`);
      osh(rec, "start", rec.name);
    }
    // A shared sandbox can predate this worktree, or have been recreated for another one.
    if (!p || run("openshell", osArgs(rec, "exec", rec.name, "--no-tty", "--", "test", "-d", `${rec.workdir}/.git`)).status !== 0) {
      addWorktree(rec);
      save(rec);
    }
    return rec;
  });
}

// Commits in the sandbox the host has not fetched, plus uncommitted files. Empty = safe to delete.
function unpulled(rec) {
  const [dirty, ...heads] = shIn(rec, 'cd "$W" && git status --porcelain | wc -l && git for-each-ref --format="%(objectname) %(refname:short)" refs/heads', { W: rec.workdir }).split("\n");
  const missing = heads.filter((l) => l && run("git", ["-C", rec.repoRoot, "cat-file", "-e", `${l.split(" ")[0]}^{commit}`]).status !== 0);
  return [...(Number(dirty) ? [`${Number(dirty)} uncommitted file(s)`] : []), ...missing.map((l) => `unpulled branch ${l.split(" ")[1]}`)];
}

function pull(rec) {
  const id = idFor(rec.checkout);
  const out = `/sandbox/.out-${id}.bundle`;
  try {
    withTmp((tmp) => {
      const status = shIn(rec, 'cd "$W" && git bundle create -q "$OUT" --branches && git status --porcelain', { W: rec.workdir, OUT: out });
      osh(rec, "download", rec.name, out, `${tmp}/`);
      const bundle = path.join(tmp, path.basename(out));
      if (!fs.existsSync(bundle)) throw new Error("download produced no bundle");
      const ns = `refs/openshell/${id}`;
      git(rec.checkout, "fetch", "-q", bundle, `+refs/heads/*:${ns}/*`);
      console.log(`fetched sandbox branches into ${ns}/*`);

      const branch = tryGit(rec.checkout, "symbolic-ref", "--short", "-q", "HEAD");
      if (branch && tryGit(rec.checkout, "rev-parse", "-q", "--verify", `${ns}/${branch}`)) {
        if (tryGit(rec.checkout, "status", "--porcelain")) console.log(`worktree has local changes; not merging. Run: git merge --ff-only ${ns}/${branch}`);
        else if (run("git", ["-C", rec.checkout, "merge", "--ff-only", "-q", `${ns}/${branch}`]).status === 0) console.log(`fast-forwarded ${branch}: ${git(rec.checkout, "log", "--oneline", "-1")}`);
        else console.log(`${branch} diverged from the sandbox; merge or rebase ${ns}/${branch} yourself`);
      }
      if (status) console.log(`not pulled, uncommitted in sandbox:\n${status}`);
    });
  } finally {
    run("openshell", osArgs(rec, "exec", rec.name, "--no-tty", "--", "rm", "-f", out));
  }
}

// Drop this worktree from its sandbox; the VM itself goes once no other worktree uses it.
// Caller holds the sandbox lock.
function release(rec) {
  const shared = sharers(rec).length > 0;
  if (shared) shIn(rec, 'rm -rf "$W"', { W: rec.workdir });
  else osh(rec, "delete", rec.name);
  fs.rmSync(recordPath(rec.checkout), { force: true });
  return shared ? `removed ${rec.workdir} from ${rec.name}` : `deleted ${rec.name}`;
}

// --- herdr entrypoints --------------------------------------------------------

const parse = (s) => { try { return JSON.parse(s || ""); } catch { return null; } };

// The focused worktree for actions: invocation context first, then the workspace list.
function focusedWorktree() {
  const ctx = parse(env.HERDR_PLUGIN_CONTEXT_JSON) || {};
  let wt = ctx.worktree || ctx.workspace?.worktree;
  if (!wt) {
    const list = parse(run(HERDR, ["workspace", "list"]).stdout)?.result?.workspaces || [];
    wt = (list.find((w) => w.workspace_id === env.HERDR_WORKSPACE_ID) || list.find((w) => w.focused))?.worktree;
  }
  return wt?.is_linked_worktree ? wt : null;
}

function onEvent() {
  const evt = parse(env.HERDR_PLUGIN_EVENT_JSON);
  const kind = (evt?.event || env.HERDR_PLUGIN_EVENT || "").replace("_", ".");
  const data = evt?.data || {};
  const checkout = data.worktree?.path;
  if (!checkout) return log(`${kind}: no worktree path in event`);

  if (kind === "worktree.created") {
    const repoRoot = data.workspace?.worktree?.repo_root;
    if (!repoRoot) return log(`${kind}: no repo_root for ${checkout}`);
    try {
      const rec = ensure(checkout, repoRoot);
      if (rec.skip) log(`${checkout}: not sandboxed (${rec.skip})`);
      else notify("Sandbox ready", `${rec.name} (${rec.workspace})`);
    } catch (e) {
      say(`${checkout}: ${e.message}`);
      notify("Sandbox failed", e.message.slice(0, 200));
    }
  } else if (kind === "worktree.removed") {
    const rec = readJson(recordPath(checkout));
    if (!rec) return;
    try {
      withLock(rec.name, () => {
        const wasStopped = phase(rec) === "Stopped";
        if (wasStopped) osh(rec, "start", rec.name);
        const left = unpulled(rec);
        const shared = sharers(rec).length > 0;
        if (!left.length) say(`${release(rec)} with its worktree`);
        else {
          say(`${rec.name} kept ${rec.workdir}: ${left.join(", ")}`);
          notify("Sandbox kept", `${rec.name}: ${left.join(", ")}`);
        }
        // Stop a VM nobody else uses, and put a stopped shared VM back to sleep.
        if ((left.length && !shared) || (wasStopped && shared)) osh(rec, "stop", rec.name);
      });
    } catch (e) {
      say(`${rec.name}: left in place, could not check for unpulled work: ${e.message}`);
    }
  }
}

function onAction() {
  const id = env.HERDR_PLUGIN_ACTION_ID;
  const wt = focusedWorktree();
  if (!wt) return notify("OpenShell", "Focus a worktree workspace first.");
  const session = id === "agent" || id === "shell";
  const r = run(HERDR, ["plugin", "pane", "open", "--plugin", env.HERDR_PLUGIN_ID || "herdr-openshell",
    "--entrypoint", session ? "session" : "task", ...(session ? ["--placement", "split", "--direction", "right"] : []),
    "--cwd", wt.checkout_path, "--env", `HOS_MODE=${id}`, "--env", `HOS_CHECKOUT=${wt.checkout_path}`,
    "--env", `HOS_REPO_ROOT=${wt.repo_root}`, "--focus"]);
  if (r.status !== 0) say(`pane open failed: ${r.stderr}`);
}

async function onPane() {
  const mode = env.HOS_MODE;
  let rl; // created lazily: a readline on the TTY must not exist while openshell owns it
  const ask = (q) => new Promise((done) => { // "" on EOF instead of a dangling promise
    rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.once("close", () => done(""));
    rl.question(q).then(done, () => done(""));
  });
  try {
    if (mode === "agent" || mode === "shell") {
      const rec = ensure(env.HOS_CHECKOUT, env.HOS_REPO_ROOT);
      if (rec.skip) throw new Error(`not sandboxed: ${rec.skip}`);
      const cmd = mode === "agent" ? rec.agent : "exec bash -l";
      const r = spawnSync("openshell", osArgs(rec, "exec", rec.name, "--tty", "--workdir", rec.workdir, "--", "bash", "-lc", cmd), { stdio: "inherit" });
      process.exit(r.status ?? 1);
    }
    const rec = readJson(recordPath(env.HOS_CHECKOUT));
    if (!rec) throw new Error("this worktree has no sandbox");
    const others = sharers(rec).length;
    if (mode === "stop") {
      osh(rec, "stop", rec.name);
      console.log(`stopped ${rec.name}${others ? ` (also stopped it for ${others} other worktree(s))` : ""}`);
    } else if (mode === "pull" || mode === "delete") {
      if (phase(rec) === "Stopped") osh(rec, "start", rec.name);
      if (mode === "pull") pull(rec);
      else {
        const left = unpulled(rec);
        const what = others ? `${rec.workdir} in ${rec.name}` : rec.name;
        if (left.length) console.log(`${what} has work the host does not:\n  ${left.join("\n  ")}`);
        const want = left.length ? "discard" : "y";
        if ((await ask(`Delete ${what}? Type "${want}" to confirm: `)).trim() !== want) console.log("kept");
        else console.log(withLock(rec.name, () => release(rec)));
      }
    }
  } catch (e) {
    say(`${mode}: ${e.message}`);
  }
  await ask("\n[enter to close]");
  rl.close();
}

// One JSON line describing the sandbox for the worktree at `dir`, for status bars:
// {} when it isn't a sandboxed worktree, {error} on bad config, else where it runs and its phase.
function onStatus(dir) {
  let out = {};
  const checkout = tryGit(dir, "rev-parse", "--show-toplevel");
  const common = checkout && tryGit(checkout, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const repoRoot = common && path.dirname(common);
  if (repoRoot && repoRoot !== checkout) { // only linked worktrees get sandboxes
    try {
      const rec = readJson(recordPath(checkout)) || resolve(checkout, repoRoot);
      if (!rec.skip) {
        let p;
        try { p = phase(rec) || "none"; } catch { p = "unreachable"; }
        out = { workspace: rec.workspace, sandbox: rec.name, workdir: rec.workdir, phase: p };
      }
    } catch (e) { out = { error: e.message }; }
  }
  console.log(JSON.stringify(out));
}

const cmd = process.argv[2];
if (cmd === "event") onEvent();
else if (cmd === "action") onAction();
else if (cmd === "pane") await onPane();
else if (cmd === "status") onStatus(process.argv[3] || process.cwd());
else { console.error("usage: herdr-openshell.mjs event|action|pane|status [dir]"); process.exit(2); }
