# @jiwnchoi/pi-input-condense

Collapse long user messages, such as pasted documents, in the transcript. Expand them with `Ctrl+O` or a left click in fullscreen mode; click an expanded message again to collapse it. Execution, tool arguments, and the transcript seen by the model remain unchanged.

## Motivation

Pi's `UserMessageComponent` has no `setExpanded`, so it does not respond to Ctrl+O. The editor collapses large pastes as `[paste #1 +N lines]`, but the transcript renders the full content. This extension adds a `render` clamp and `setExpanded` to the prototype so Pi's global expansion also applies to these rows.

## Scope

This package only handles user messages, not tool calls. Collapsed tool rows are owned by `@pi-kaush/pi-tool-call-markers`.

## Installation status

The extension is registered in the `packages` field of `~/.pi/agent/settings.json`:

```json
"packages": ["./packages/@jiwnchoi/input-condense", ...]
```

## Configuration

`~/.pi/agent/input-condense.json` (defaults shown):

```json
{
  "enabled": true,
  "inputCollapsedRows": 4,
  "inputShowOmittedCount": true,
  "inputExpandHint": false,
  "inputMinRows": 12
}
```

| Key                     | Default | Description                                            |
| ----------------------- | ------- | ------------------------------------------------------ |
| `enabled`               | `true`  | When false, delegate to the original renderer.         |
| `inputCollapsedRows`    | `4`     | Number of rows in a collapsed user message.            |
| `inputShowOmittedCount` | `true`  | Show the `+N lines` count.                             |
| `inputExpandHint`       | `false` | Show `Ctrl+O to expand` on user messages.              |
| `inputMinRows`          | `12`    | Do not collapse messages with this many rows or fewer. |

Changes are detected using the file's modification time and do not require a session restart. Changes to the extension code itself require restarting Pi.

## Known limitations

- Collapsing user messages patches Pi's internal `UserMessageComponent.prototype`. If a Pi update changes its internals, the extension falls back silently to the original renderer.
- Click-to-expand and collapse work only in fullscreen mode, where Pi receives mouse events. In normal mode, the terminal handles the mouse; use `Ctrl+O` instead.
- Short messages, right clicks, clicks with modifier keys, and drags are not consumed as expansion interactions.

## Tests

The tests use the workspace's Pi packages to verify the real user-message renderer and mouse dispatch. Run from the repository root:

```bash
pnpm test
```
