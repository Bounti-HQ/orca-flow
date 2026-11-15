# Orca Flow

A sidebar for [Orca](https://github.com/stablyai/orca) when you run many Claude Code agents at
once. It answers two questions at a glance: what needs me next, and can the machine take more work.

- **Cockpit**: free memory at a glance; open it for what each session and its dev servers use, with one-click cleanup.
- **Up next**: agents waiting on you, most urgent first, each with what it is about and the
  question it is asking.
- **Coordinators**: long-lived Claude sessions, each in its own folder, that plan work and hand it
  to Orca workers. Their workers are listed under them.
- **End-of-turn summaries**: when an agent finishes a turn, Claude Haiku turns its transcript into
  a title, a one-line "about" and the ask, so you can switch back in seconds.

macOS only for now.

## Requirements

- Orca 1.4.248 or newer, with Claude Code agents.
- The `claude` CLI, logged in (summaries use Haiku through the same login, a fraction of a cent
  per turn).
- Node 22.18 or newer, for the `orca-flow` script coordinators run.

## Install

```sh
orca plugin install <repository-url>
```

Orca shows the access the plugin asks for: running a trusted worker, reading and opening
workspaces, reading agent status and launching agents. Approve it, then open the panel from the
right sidebar (the layers icon).

When it starts, the plugin sets up two things outside its folder:

| Path | What it is | Used by |
| --- | --- | --- |
| `<Claude profile>/skills/orca-flow` | a link to `skills/orca-flow`, updated when the plugin updates | every agent: the coordinator, lead and worker roles, and the `orca-flow` script for the queue, capacity checks and workstream cards |
| `~/orca/coordinators/CLAUDE.md` | copied once from `coordinator/CLAUDE.md`, then yours | every coordinator folder; holds your project notes |

A real file already at either path is left alone. The Claude profile is the one Orca's
agents use (Orca's selected profile, else `~/.claude`).

## Where things live

- `~/.orca-flow/agents/`: one summary per agent pane, written by the plugin.
- `~/.orca-flow/cards/`: priority, role and goal per worktree, written by coordinators with
  `orca-flow set`.
- `~/.orca-flow/config.json`: the memory margin to keep free, if you change it (`{"marginGB": 2}`).
- `~/orca/coordinators/<name>/`: one folder per coordinator, with its `coordinator.json` scope.

## Develop

```sh
scripts/dev.sh check   # types, tsc, plugin tests and orca-flow tests
scripts/dev.sh load    # approve and (re)start the worker
scripts/dev.sh shot    # screenshot the panel to /tmp/orca-sidebar-shots
```

`src/worker.ts` is the plugin's worker; `src/view.ts` renders the panel as HTML, which
`src/panel/app.ts` draws and wires up. Orca transpiles TypeScript when it loads, so there is no
build step. See Orca's
[plugin authoring guide](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-authoring.md).

## License

MIT. See [LICENSE](LICENSE).
