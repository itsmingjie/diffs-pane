---
name: diffs-pane
description: Live diff review between humans and coding agents with the dp CLI. Use when asked to open or share a diff viewer, review working-tree changes, read or address inline feedback, resolve review comments, or show changes from the latest agent turn.
license: Apache-2.0
compatibility: Requires Node.js 24+, the dp executable, and a Git or jj working tree.
---

# diffs-pane

`dp` gives humans a live browser view of an agent’s working-tree changes. Humans
leave inline comments; agents read them from the CLI, fix the code, and resolve
only the feedback they addressed.

Install: `pnpm add --global diffs-pane`

## Start here

From the repository being reviewed:

```sh
dp watch
```

The command prints one authenticated localhost URL. Share it with the user. The
viewer follows filesystem changes automatically, so do not rerun `dp watch`
after every edit and do not repeatedly print the URL.

Useful variants:

```sh
dp watch branch                            # full branch diff (default)
dp watch unstaged                          # worktree diff
dp watch turn                              # changes since turn start
dp watch --root /path/to/repo --base main
dp watch --theme one-dark-pro              # choose a viewer theme
dp watch --font-family "Dank Mono" --font-size 13 --line-height 20
dp watch --owner <integration-name>         # hold an integration lease
dp watch --no-watch                         # static viewer without live updates
```

## Review workflow

When the user asks to address review comments:

1. Read the current feedback. This is non-destructive and safe to repeat.

   ```sh
   dp reviews
   dp reviews --json
   ```

   Text output uses blocks such as:

   ```text
   <File>src/app.ts:12-15 (additions, branch)</File>
   <Comment>
   Extract this into a helper.
   </Comment>
   <Diff>
   @@ -10,6 +10,9 @@ function main() {
    ...
   </Diff>
   ```

   `<File>` contains `path:line-range (side, source[, outdated])`. An outdated
   comment refers to lines that changed after it was created; use its saved
   `<Diff>` excerpt to recover the intent. JSON output includes stable comment
   ids and, for live sessions, direct browser URLs.

2. Fix each comment in the repository. Comments re-anchor automatically when
   their saved text has one unambiguous match.

3. Resolve only comments that were actually addressed:

   ```sh
   dp resolve <comment-id> [<comment-id>...]
   ```

   Use `dp resolve --all` only when every current comment was handled. Resolution
   updates an open viewer immediately.

4. Summarize the fixes and identify any feedback left unresolved.

## Turn tracking

Turn tracking powers the viewer’s **Last turn** source:

```sh
dp turn start --session <session-id> --turn <turn-id> --agent <name>
# perform the work
dp turn end --session <session-id> --turn <turn-id>
```

`start` captures a read-only baseline and is idempotent while the same turn is
active. It does not modify the index or working tree. Prefer lifecycle hooks
when the harness supports them.

## Session commands

```sh
dp status [--json]
dp stop [--root <path>] [--owner <name>]
dp stop --owner <name> --all
dp stop --all
```

A working tree has one shared session. Owners are leases; the session stops only
when its final lease is released, and the daemon exits when no sessions remain.

## Operational rules

- Share a capability URL only with the intended local user.
- Do not open the browser yourself unless the user asks for UI inspection.
- Never edit persisted review files by hand; use `dp reviews` and `dp resolve`.
- Never resolve a comment that was not addressed.
- Do not mutate the repository to obtain a diff. `dp` is read-only and never
  runs automatic jj recovery commands.
