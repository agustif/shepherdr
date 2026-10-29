# Settings

- Settings (sidebar, or `,` on a desktop) holds the few app settings, in two groups. What agents are told: How tasks
  work, only words in each new brief's Settings block (review, the Reviewer a brief suggests, Must fix, Review rounds,
  merge), each row showing the exact line it adds. How Shepherdr runs: the agent, model and effort tasks and
  coordinators start with (model:
  an id or alias, or default for the CLI's own; effort: default, lowest, low, medium, high, xhigh or max, each CLI
  taking it its own way) and tasks' backup agent, when Done tasks archive themselves, Autopilot's heartbeat (its trigger) and checklist, the time zone of every schedule, each machine's limits, the idle browser, Notify, alerts and voice. Its
  defaults are set Everywhere, for a machine or for a space (`shepherdr set <key> <value> [--machine | --space NAME]`, from any machine);
  the most specific one set wins. And, kept on each device, its Appearance: System (the device's own light
  or dark), Light or Dark, set before the first paint, with the browser's bar and artifacts following it. A phone
  lists the sections in groups, as iOS's Settings does, and opens one over the list; a wider screen keeps the list
  down its side.

## Coding agents in this fork

Settings → Agents chooses the coordinator, task, and backup CLI. Settings → How tasks work chooses the reviewer.
Claude Code, Codex, pi, OpenCode, and Grok can be reviewers. Each CLI must already be installed and authenticated
on the machine where it runs; choosing an agent never copies another CLI's credentials.

| CLI | Structured chat on the main machine | Model selection | Native session storage |
| --- | --- | --- | --- |
| Claude Code, Codex, pi | Existing readers | Existing model and effort controls | Existing JSONL logs |
| OpenCode 2.1.4 | Replies, tool steps/output, questions, usage, and turn completion | `opencode models`; provider/model IDs | Read-only SQLite `session_v2` / `session_message` projection |
| Grok Build 1.0.70 | Streamed replies, tool steps/output, questions, usage, background jobs, and turn completion | `grok models`; advertised IDs and default | `GROK_HOME/sessions/<encoded cwd>/<UUID>/updates.jsonl` |

OpenCode starts its full TUI with a private server and an explicit session ID. A selected model goes into a scoped
`OPENCODE_CONFIG_CONTENT` environment; its configuration files stay intact. Grok receives its own session/resume
and model flags. Task worktrees use each CLI's automatic permission mode; coordinators retain native approvals.
Neither model-list command advertises per-model effort capabilities, so these two agents use their CLI's effort
default. OpenCode model variants can also be configured in OpenCode itself.

OpenCode's private transcript cache uses mode `0600`, inside a `0700` directory in `~/.shepherdr/opencode`.
Each refresh reads at most 256 new rows and 16 unfinished assistant rows, with a roughly 2 MiB byte budget.
Records exceeding 1 MiB produce a diagnostic. Unsupported schemas and locked databases leave the terminal usable
and log a throttled warning. Historical completed-message edits or deletions are not re-imported.

Structured OpenCode and Grok transcript ingestion is currently local to the main machine. Remote workers keep
their ordinary herdr terminal access; they never read the main machine's native session stores. Native permission
prompts remain available through the terminal, including Grok requests that are not persisted in its transcript.

Authenticate through each CLI, for example `opencode auth login` or `grok login`. Authentication is a separate
step from installing the CLI or selecting it in Settings.

OpenCode's adapter follows the [v2.1.4 schema](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/schema/src/session-message.ts).
Grok's adapter follows installed 1.0.70 ACP notifications and the [upstream agent protocol](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md).
