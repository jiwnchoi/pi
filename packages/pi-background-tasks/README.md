# @jiwnchoi/pi-background-tasks (local UI fork)

Local fork of `pi-background-tasks@2.6.10` used only to restyle the footer dock and
the task manager so they follow the active Pi theme instead of a hardcoded
light-blue ANSI palette.

## What changed

- The footer dock is now an `aboveEditor` widget rendered above the editor
  instead of a `setStatus` line below it.
- Every hardcoded `\x1b[48;2;183;223;255m` / `\x1b[38;2;11;70;110m` /
  `\x1b[38;2;83;160;215m` color is gone. The dock text uses theme tokens
  (`accent`, `muted`, `dim`, `success`, `error`, `warning`), and the task manager
  frame uses `border`, `accent`, and `selectedBg`.
- The upstream npm update check is disabled. `/bg-update` prints local-fork
  instructions instead of npm update commands.

## Layout

```
dist/          compiled ESM copied from the npm release, edited in place
node_modules/  symlinks to the host SDK plus turndown/domino
```

`dist/src/extension.js` owns the footer widget and `/bg-update`.
`dist/src/ui/background-tasks-manager.js` owns the task manager overlay.

## Reverting to upstream

Remove `./packages/@jiwnchoi/pi-background-tasks` from `packages` in
`~/.pi/agent/settings.json`, then run `pi install npm:pi-background-tasks@latest`.
