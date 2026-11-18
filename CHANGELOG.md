# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-18

### Added

- One OpenShell microVM sandbox per herdr worktree, or one per space (`"sandbox": "space"`).
- Space configs from a `.herdr-openshell.json` folder file or origin-prefix matches in the plugin config.
- Repo `.openshell/sandbox.json` and `policy.yaml`, read only from the trusted default branch.
- `agent`, `shell`, `pull`, `stop` and `delete` actions, plus `worktree.created` / `worktree.removed` hooks.
- Missing providers are created from host env vars (`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, ...), overridable per space with `"credentials"`.
- `status [dir]` subcommand and the `openshell-status` Herdr.app status bar mod.

[0.1.0]: https://github.com/leszek-niewiadomski/herdr-openshell/releases/tag/v0.1.0
