// Herdr.app side of herdr-openshell: the status bar with the focused worktree's OpenShell sandbox
// in it. Clicking the sandbox opens its actions; keys.json can bind them as
// "openshell-status.agent" (shell, pull, stop, delete). Every action runs the plugin script in a
// terminal, so both herdr clients share one implementation.
// ponytail: a copy of the shipped `workspace-status` bar plus one chip, because mods can't import
// or embed each other; re-copy its render() when Herdr changes that bar.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, agents, panes, focused, theme, run, window, keys, exec, appHome, checking,
  props, nextCommand, notify, openOverlay, closeOverlay } from "herdr";

const REFRESH_MS = 15000; // phase changes (stopped, started) show up within this
const GC_MS = 10 * 60e3; // Herdr.app has no worktree-removed event, so look for removed ones this often
const MODES = { agent: "Start agent", shell: "Open shell", pull: "Pull commits", stop: "Stop VM", delete: "Delete sandbox…" };

// The focused terminal's folder, found as the shipped Changes panel does. Sandboxes are local,
// so a space on another machine has none.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  if (space?.machine) return null;
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return pane?.cwd || f?.cwd || space?.folder || null;
}

// This mod folder is a symlink into the plugin's repo, which holds the script that does the work.
// The PATH is the one exec() sees, so terminals find git and openshell even when herdr-core
// started without the login shell's.
async function locate() {
  const r = await exec("sh", ["-c", 'cd "$1" && cd "$(pwd -P)/../.." && printf "%s\\n%s\\n%s" "$PWD/herdr-openshell.mjs" "$(command -v node)" "$PATH"',
    "sh", `${appHome()}/mods/openshell-status`]);
  const [script, node, PATH] = r.stdout.split("\n");
  if (r.code !== 0 || !node) throw new Error(`can't find node or the plugin: ${r.stderr.trim()}`);
  return { script, node, PATH };
}

// agent/shell open beside the focused pane, like the herdr plugin's split; the rest open below.
function launch(tools, mode, dir) {
  const side = mode === "agent" || mode === "shell" ? "right" : "down";
  run("terminal.open", { argv: ["/usr/bin/env", `PATH=${tools.PATH}`, tools.node, tools.script, "run", mode, dir], folder: dir, place: side, name: `openshell ${mode}` });
}

// Which actions make sense in a phase: no VM yet means only the ones that create it.
const available = (phase) => Object.keys(MODES).filter((m) =>
  m === "agent" || m === "shell" || (phase && phase !== "none" && (m !== "stop" || !["Stopped", "unreachable"].includes(phase))));

export default class OpenShellStatus extends View {
  init(p, cx) {
    this.info = {};
    this.at = 0;
    if (checking() || p?.menu) return;
    cx.spawn(async (cx) => {
      try { this.tools = await locate(); } catch (e) { this.info = { error: String(e) }; cx.notify(); return; }
      this.gc(cx);
      // A cheap tick: it runs the plugin only when the folder changed or the info is stale.
      cx.timer.every(1000, (cx) => {
        const dir = location();
        if (dir !== this.dir || Date.now() - this.at > REFRESH_MS) this.refresh(dir, cx);
      });
      cx.timer.every(GC_MS, (cx) => this.gc(cx));
    });
    // Uses its cx each round: that is what ends this loop when a save reloads the mod. A loop that
    // never touches cx outlives its copy and swallows the commands meant for the new one.
    cx.spawn(async (cx) => {
      for (;;) {
        const mode = await nextCommand();
        if (!MODES[mode]) continue;
        if (this.tools && this.info.sandbox && this.dir === location()) launch(this.tools, mode, this.dir);
        else notify({ title: "OpenShell", body: "Focus a terminal in a sandboxed worktree first." });
        cx.notify();
      }
    });
  }

  refresh(dir, cx) {
    if (this.busy) return;
    this.busy = true; this.dir = dir; this.at = Date.now();
    cx.spawn(async (cx) => {
      let info = {};
      try {
        if (dir) {
          const r = await exec(this.tools.node, [this.tools.script, "status", dir], { timeout: 20000 });
          info = r.code === 0 ? JSON.parse(r.stdout || "{}") : { error: (r.stderr || "status failed").trim().split("\n").pop() };
        }
      } catch (e) { info = { error: String(e) }; }
      this.busy = false;
      if (dir !== location()) return; // focus moved on; the next tick asks again
      if (JSON.stringify(info) !== JSON.stringify(this.info)) { this.info = info; cx.notify(); }
    });
  }

  gc(cx) {
    if (this.collecting) return;
    this.collecting = true;
    cx.spawn(async () => {
      try {
        // Booting a stopped VM to check a removed worktree for unpulled work can take a while.
        const r = await exec(this.tools.node, [this.tools.script, "gc"], { timeout: 600000 });
        for (const body of JSON.parse(r.stdout || "[]")) notify({ title: "Sandbox kept", body, level: "warning" });
      } catch {} finally { this.collecting = false; }
    });
  }

  openMenu() {
    const modes = available(this.info.phase);
    openOverlay({ mod: "openshell-status", kind: "popup", width: 220, height: 46 + 31 * modes.length,
      props: { menu: true, modes, dir: this.dir, info: this.info, tools: this.tools } });
  }

  menu(t) {
    const { modes, dir, info, tools, overlay } = props();
    return v_flex().w_full().p(5).bg(t.popover).text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child(`${info.workspace} / ${info.sandbox}`))
      .children(modes.map((mode) => h_flex().id(`openshell-${mode}`).h(31).px(8).rounded(7).items_center()
        .text_color(t.foreground).hover((s) => s.bg(t.hover)).cursor_pointer()
        .on_click(() => { launch(tools, mode, dir); closeOverlay(overlay); })
        .child(MODES[mode])));
  }

  sandbox(t, label) {
    const { sandbox, workspace, phase, workdir, error } = this.info;
    if (!sandbox && !error) return null;
    const color = error || phase === "unreachable" ? t.blocked : phase === "Ready" ? t.accent : t.dim;
    const state = error ? "error" : phase === "none" ? "not created" : phase.toLowerCase();
    return label("sandbox", error ? "sandbox config error" : `${workspace} / ${sandbox}`)
      .id("openshell").tooltip(error ? `OpenShell: ${error}` : `OpenShell sandbox ${sandbox} (workspace ${workspace}), clone at ${workdir}. Click for actions.`)
      .when(!error, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(() => this.openMenu()))
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
    if (props()?.menu) return this.menu(t);
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
