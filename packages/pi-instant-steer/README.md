# @jiwnchoi/pi-instant-steer

An extension that brings OpenAI Codex's `instant_interrupt` behavior to Pi.

## Problem

Pi queues steering messages submitted while it is working and delivers them **after the current batch of tools finishes**. Codex instead interrupts the turn and immediately sends pending steering input when the interrupt key is pressed (Codex 0.163.0, `Enable instant interrupts by default`).

Pi's default Esc behavior clears the queue and **returns the input to the editor**, requiring it to be submitted again.

## Behavior

When a run ends **aborted** with undelivered steering input, the extension extracts that steering text from the draft restored to the editor and **immediately submits it as a new turn**.

- Follow-up messages and the user's draft remain in the editor. Codex likewise defers follow-ups until the turn ends.
- Interrupting while idle or without pending input preserves the existing behavior.
- The editor is not replaced. Only the `input`, `message_start`, and `agent_settled` events are used to avoid conflicts with extensions that wrap the editor, such as `pi-zentui`.
- Steering queue tracking follows Pi's own rules: entries are registered on submission and removed when the corresponding user message starts, so already delivered messages are not resent.
- Only TUI mode is affected; RPC, JSON, and print modes are unchanged.

While working, the footer displays `esc → send steer now`.

## Usage

```
/instant_steer on|off|status
```

Press Esc while working to send pending steering input immediately.

## Installation status

The extension is registered as `packages/@jiwnchoi/instant_steer` in the `packages` field of `~/.pi/agent/settings.json`.
