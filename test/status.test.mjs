// `status` resolves a worktree's sandbox from the folder config without a gateway, so it covers
// the config lookup and the trust rules: the workspace and isolation level come from the user's
// files, never from the repo's .openshell/ files.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(import.meta.dirname, "../herdr-openshell.mjs");
const homes = [];
after(() => homes.forEach((h) => fs.rmSync(h, { recursive: true, force: true })));

function setup(folderConfig, repoConfig) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hos-home-")));
  homes.push(home);
  const repo = path.join(home, "src", "app");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  fs.mkdirSync(repo, { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  if (repoConfig) {
    fs.mkdirSync(path.join(repo, ".openshell"));
    fs.writeFileSync(path.join(repo, ".openshell/sandbox.json"), JSON.stringify(repoConfig));
    git("add", ".");
  }
  git("commit", "-q", "--allow-empty", "-m", "init");
  git("worktree", "add", "-q", path.join(home, "src", "app-feat"), "-b", "feat");
  if (folderConfig) fs.writeFileSync(path.join(home, "src", ".herdr-openshell.json"), JSON.stringify(folderConfig));
  // An empty PATH apart from git: no openshell, so the phase is "unreachable".
  const status = (dir) => JSON.parse(execFileSync(process.execPath, [SCRIPT, "status", dir], {
    env: { HOME: home, PATH: path.dirname(execFileSync("sh", ["-c", "command -v git"]).toString().trim()) },
  }).toString());
  return { home, repo, wt: path.join(home, "src", "app-feat"), status };
}

test("no folder config: not sandboxed", () => {
  const { wt, status } = setup(null);
  assert.deepEqual(status(wt), {});
});

test("main checkout is never sandboxed", () => {
  const { repo, status } = setup({ workspace: "work" });
  assert.deepEqual(status(repo), {});
});

test("worktree mode: one sandbox per worktree, clone at /sandbox/<repo>", () => {
  const { wt, status } = setup({ workspace: "work" });
  const s = status(wt);
  assert.equal(s.workspace, "work");
  assert.match(s.sandbox, /^app-feat-[0-9a-f]{6}$/);
  assert.equal(s.workdir, "/sandbox/app");
  assert.equal(s.phase, "unreachable");
});

test("space mode: sandbox named after the repo, clone per worktree", () => {
  const { wt, status } = setup({ workspace: "work", sandbox: "space" });
  const s = status(wt);
  assert.match(s.sandbox, /^app-[0-9a-f]{6}$/);
  assert.equal(s.workdir, "/sandbox/app/app-feat");
});

test("the repo cannot pick the workspace or the isolation level", () => {
  const { wt, status } = setup({ workspace: "work" }, { workspace: "other", sandbox: "space" });
  const s = status(wt);
  assert.equal(s.workspace, "work");
  assert.equal(s.workdir, "/sandbox/app");
});

test("bad isolation level is reported, not ignored", () => {
  const { wt, status } = setup({ workspace: "work", sandbox: "vm" });
  assert.match(status(wt).error, /"sandbox" must be/);
});
