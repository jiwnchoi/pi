# @jiwnchoi/pi-artifact

Use the Claude Code Artifact tool from Pi, via the `artifact` tool or `/artifact` command. Requires Claude Code installed and signed in to claude.ai with a plan that supports artifacts. Set `CLAUDE_ARTIFACT_MODEL` to override the default `haiku` model.

`/artifact path/to/file.html` publishes a file; `/artifact ./site` publishes a folder containing `index.html`. The command asks for confirmation before publishing.
