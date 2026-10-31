# pi-petrroll

Small, focused extensions for [Pi](https://pi.dev). MIT licensed.

| Extension | Command | Agent tool |
| --- | --- | --- |
| [Change directory](#change-directory) | `/cd <path>` | `change_directory` |
| [External costs](#external-costs) | — | `add_cost` |
| [Scrollbar marks](#scrollbar-marks) | — | — |

Independent, focused extensions. No skills, shell wrappers, or replacement built-in tools.

## Install

Requires **Pi 0.85.1 or newer** (`@earendil-works/pi-coding-agent`); tested against 0.85.1 and 1.1.0. Change directory requires interactive mode; external cost recording works in all modes. Earlier Pi versions may not rebuild cwd-bound services when switching sessions.

```sh
pi install npm:pi-petrroll
```

Or install directly from GitHub:

```sh
pi install git:github.com/petrroll/pi-petrroll
```

Run `/reload` in an existing Pi session, or start Pi. Install globally (the default), so the extension remains available when switching projects.

For local development, use this checkout instead of the npm or GitHub install:

```sh
pi install /absolute/path/to/pi-petrroll
```

Choose one installation source, not multiple.

### Enable only what you need

One package does **not** mean all extensions must be enabled. Run `pi config` to toggle each extension independently, or `pi config -l` for project-specific choices. Then `/reload` running sessions.

All extensions load by default. To load only `cd`, including after future updates, use this package entry in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    { "source": "npm:pi-petrroll", "extensions": ["extensions/cd/index.ts"] }
  ]
}
```

Disabling `cd` disables both `/cd` and its `change_directory` tool. Disabling `cost` disables `add_cost`. Disabling `scrollbar-marks` restores Pi's plain scrollbar. To load only cost recording, use `"extensions": ["extensions/cost/index.ts"]` in the package entry above.

## Change directory

### Let the agent do it

For example, start Pi in `~/projects` and ask:

> Create a worktree of pi-mono for issue #123, switch this session into it, and fix the issue there.

The agent uses ordinary `bash`/Git to create the worktree, then calls:

```json
{ "path": "~/projects/pi-issue-123" }
```

with the `change_directory` tool. Once the current run settles, Pi copies the conversation into the worktree's session storage, switches to that session, and automatically continues the task there.

No quit, terminal `cd`, restart, or cross-directory session-copy confirmation. **Normal Pi project-trust prompts and other extensions' session-switch guards still apply.** This extension does not automatically trust destination code.

### Change it yourself

```text
/cd ~/projects/pi-issue-123
/cd ../another-worktree
/cd /home/me/projects/a folder with spaces
/cd "../a folder with spaces"
```

Bare `/cd` shows the current directory and usage. Relative paths use Pi's current cwd. `~`, `~/…`, single-quoted paths, JSON double-quoted paths, and symlinks are supported. Paths are not shell commands: no variable expansion, globbing, `~username`, or `cd -`.

Manual `/cd` switches without starting another model response; the agent tool resumes automatically **after session replacement has fully completed**. The tool intentionally ends the old run, but normally needs no manual `continue`. An existing destination is required. The extension does not create directories or worktrees itself.

### What changes

- A new session ID and session file are created for the destination, using Pi's `SessionManager.forkFrom()`.
- The original session is left in place. The full conversation tree is copied, and the currently selected branch is preserved.
- Pi's native session replacement rebuilds built-in tools, the working-directory display, settings, extensions, skills, and project context such as `AGENTS.md` for the destination.
- `pi -c` from the destination can continue the copied session. Copies stay in the source session's storage: if it uses a custom session directory (`--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, or the `sessionDir` setting), the copy is written there too, so `pi --session <id>` and `/resume` find it under the same override. Otherwise copies use Pi's normal per-directory storage for the destination (respecting `PI_CODING_AGENT_DIR`).
- No `process.chdir()` trick, built-in tool overrides, or Pi internals are patched. Your parent terminal's working directory does **not** change.

### Safety and limitations

- Interactive/TUI mode only. Print, JSON, RPC, and `--no-session` are deliberately unsupported in this first version.
- Linux is tested locally and in Ubuntu CI. Windows is expected to work but has not been verified. For manual commands on Windows, prefer `/cd "C:/Users/you/worktree with spaces"`; double-quoted backslashes are interpreted as JSON escapes. Use `~/path`, not `~\path`. The agent tool handles quoting automatically.
- Pi's session cwd changes, but Node's `process.cwd()` does not. Third-party extensions that use process-relative filesystem paths or spawn commands without an explicit cwd may still operate in the original directory. Pi's built-in tools and `pi.exec()` use the rebuilt session/extension cwd.
- Switching does not recreate shell environment changes such as `direnv` or virtualenv activation, and does not move already-running background processes.
- The session must already be saved. In a brand-new session, send a message first.
- The agent should call `change_directory` **alone**, after worktree creation has completed. The tool requests early termination and the command waits for idle so completed tool results are included in the copy. If mixed with other tools, those calls still run in the **old** directory; the switch waits until the run settles.
- Explicitly aborting a pending tool handoff prevents the switch. Invalid paths and concurrent requests are rejected.
- A cancelled session switch removes the unused copy and keeps the original session. If Pi fails while rebuilding the replacement runtime, its normal fatal-error handling applies; the original and any created copy remain available for recovery.
- If submitting the automatic continuation fails, the extension warns without treating the successful switch as a failure. Model errors and user aborts still follow Pi's normal behavior; the extension does not retry aborted runs. Send `continue` in the destination if needed.
- The copied history can contain references to the old project. A visible context message records the change, and the new system prompt contains the destination's instructions.
- Switching reloads project extensions according to Pi's trust policy. Install only code you trust.

## External costs

After launching a subagent with the ordinary `bash` tool, Pi can call `add_cost` to include the subagent's reported cost in the **current session's native cost total**:

```json
{
  "amount": 0.0375,
  "reason": "Bash-launched review subagent, run review-123"
}
```

- `amount` is an additional, finite, non-negative cost in **USD**, not cents. Zero is allowed.
- `reason` is a required, non-blank description (up to 1000 characters), saved with the tool result for an audit trail.
- Costs appear in Pi's footer, `/session`, and RPC session statistics. Pi stores them as tool-result usage, so they survive reload/resume and compaction without inventing token counts or changing the parent model's usage.
- Works in interactive, print, JSON, and RPC modes, including in-memory sessions. `--no-session` costs exist only for that process.
- This is accounting only: the tool does not launch anything, inspect subagent output, estimate pricing, or charge money. The agent must obtain the cost from the external run first.

**Every successful call is additive; there is no deduplication.** Report each external cost once. For a continued subagent, report only the new, unrecorded cost—not its cumulative lifetime total. Do not report parent-session model costs or nested usage already returned by another tool. If the external cost is unknown, do not guess.

Pi's totals include all entries in the session file, including abandoned branches. Forked or copied sessions inherit costs present in their copied history; a new empty session starts at zero. No session files or Pi internals are patched.

## Scrollbar marks

Marks where your prompts and the assistant's replies start on the scrollbar at the right of Pi's fullscreen transcript, like an editor's overview ruler:

- **Prompts**: `━` in the theme's accent color.
- **Replies** (assistant text): `─` in the text color.

Under the thumb, a mark crosses it as `╋` (accent for prompts, the thumb color for replies), so the thumb keeps its width. While you drag the scrollbar, Pi shows a solid `█` thumb. Prompts then recolor it to accent, and reply marks are hidden.

Each mark sits at its proportional position in the transcript, so dragging or scrolling the thumb onto a mark brings that message into view. Prompts win when both fall on the same row. Tool output, thinking-only, and tool-call-only assistant turns are not marked.

The marks appear whenever Pi shows the scrollbar. With the default `"fullscreenScrollbar": "auto"`, that is only briefly while scrolling. Set `"fullscreenScrollbar": "always"` in `~/.pi/agent/settings.json` to keep the scrollbar and marks visible.

Limitations:

- Fullscreen TUI mode only (Pi's default `tuiMode`). In regular mode the terminal owns scrollback and the scrollbar, so the extension does nothing. Print, JSON, and RPC modes are unaffected.
- Pi has no public scrollbar API yet. The extension wraps the transcript `ScrollView`'s scrollbar style callbacks and content render on that one instance, and wraps `UserMessageComponent.render` once per process to tell prompts from replies. It finds message starts from the OSC 133 zone markers Pi already renders. Disabling or reloading restores the original callbacks. Tested against Pi 1.4.0; future Pi versions may change these internals.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Tests cover scrollbar mark detection, scaling, painting, and restoration, cost validation, native cost accumulation, persistence/resume, compaction, path handling, copy/branch preservation, cancellation, aborts, concurrency, and a real Pi runtime handoff with a fake model stream. The runtime test verifies that tool results are copied, `read` and `bash` use the new cwd, destination `AGENTS.md` replaces source context, and the agent continues only after the host finishes switching. Unit tests also cover continuation-submission failures without rolling back the successful switch. Tests do not call a model API or use your credentials.

```text
extensions/
  cd/
    index.ts
  cost/
    index.ts
  scrollbar-marks/
    index.ts
    marks.ts
tests/
  cd.test.ts
  cost.test.ts
  runtime.test.ts
  scrollbar-marks.test.ts
```

Pi discovers entry points through `pi.extensions` in `package.json`. Add future independent extensions under `extensions/<name>/index.ts`; no new skill or package is needed. Keep helpers inside the extension directory so they are not discovered as standalone extensions.

## License

[MIT](LICENSE) © 2026 Petr Houška.
