// Herdr.app status bar with the focused worktree's OpenShell sandbox in it.
// ponytail: a copy of the shipped `workspace-status` bar plus one chip, because mods can't import
// or embed each other; re-copy its render() when Herdr changes that bar.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, panes, focused, theme, run, window, keys, exec, appHome, checking } from "herdr";

const REFRESH_MS = 15000; // phase changes (stopped, started) show up within this

// The focused terminal's folder, found as the shipped Changes panel does. Sandboxes are local,
// so a space on another machine has none.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  if (space?.machine) return null;
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return pane?.cwd || f?.cwd || space?.folder || null;
}

export default class OpenShellStatus extends View {
  init(_props, cx) {
    this.info = {};
    this.at = 0;
    if (checking()) return;
    // A cheap tick: it runs the plugin only when the folder changed or the info is stale.
    cx.timer.every(1000, (cx) => {
      const dir = location();
      if (dir !== this.dir || Date.now() - this.at > REFRESH_MS) this.refresh(dir, cx);
    });
  }

  refresh(dir, cx) {
    if (this.busy) return;
    this.busy = true; this.dir = dir; this.at = Date.now();
    cx.spawn(async (cx) => {
      let info = {};
      try {
        if (dir) {
          // This mod folder is a symlink into the plugin's repo; the plugin works out the sandbox.
          const r = await exec("sh", ["-c", 'cd "$1" && cd "$(pwd -P)/../.." && exec node herdr-openshell.mjs status "$2"',
            "sh", `${appHome()}/mods/openshell-status`, dir], { timeout: 20000 });
          info = r.code === 0 ? JSON.parse(r.stdout || "{}") : { error: (r.stderr || "status failed").trim().split("\n").pop() };
        }
      } catch (e) { info = { error: String(e) }; }
      this.busy = false;
      if (dir !== location()) return; // focus moved on; the next tick asks again
      if (JSON.stringify(info) !== JSON.stringify(this.info)) { this.info = info; cx.notify(); }
    });
  }

  sandbox(t, label) {
    const { sandbox, workspace, phase, workdir, error } = this.info;
    if (!sandbox && !error) return null;
    const color = error || phase === "unreachable" ? t.blocked : phase === "Ready" ? t.accent : t.dim;
    const state = error ? "error" : phase === "none" ? "not created" : phase.toLowerCase();
    return label("sandbox", error ? "sandbox config error" : `${workspace} / ${sandbox}`)
      .id("openshell").tooltip(error ? `OpenShell: ${error}` : `OpenShell sandbox ${sandbox} (workspace ${workspace}), clone at ${workdir}`)
      .child(div().text_color(color).child(`· ${state}`));
  }

  // From here on: the shipped workspace-status bar, plus the sandbox chip after the branch.
  hint() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const icon = (name) => name === "sandbox" ? "mods/openshell-status/sandbox.svg" : `mods/workspace-chrome/${name}.svg`;
    const label = (name, text) => h_flex().gap(6).items_center().child(svg(icon(name)).size(13)).child(text);
    const sandbox = this.sandbox(t, label);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .when(Boolean(sandbox), el => el.child(sandbox))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint()));
  }
}
