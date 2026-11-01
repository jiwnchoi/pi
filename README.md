# @jiwnchoi/pi

I LOVE PI

This repo is pi extension packages built by @jiwnchoi .

All extensions are tested in pi and pi-bolt

- [`@jiwnchoi/pi-artifact`](packages/pi-artifact)
- [`@jiwnchoi/pi-cached-compaction`](packages/pi-cached-compaction)
- [`@jiwnchoi/pi-tool-rows`](packages/pi-tool-rows)
- [`@jiwnchoi/pi-input-condense`](packages/pi-input-condense)
- [`@jiwnchoi/pi-instant-steer`](packages/pi-instant-steer)
- [`@jiwnchoi/pi-background-tasks`](packages/pi-background-tasks)
- [`@jiwnchoi/pi-pele-mermaid`](packages/pi-pele-mermaid)

Run `pnpm install` to install workspace dependencies and Git hooks, and `pnpm test` to run available tests. Packages are private and are not published to npm.

Development checks: `pnpm typecheck` (tsrs, currently beta), `pnpm lint` (oxlint), and `pnpm format:check` (oxfmt). Run `pnpm format` to apply formatting. Lefthook runs these checks before commits; they check the workspace, including unstaged changes. Generated `dist/` files are excluded.

`pi-background-tasks` is a local fork distributed here as its modified compiled `dist/`; its original source and build scripts are not available in this checkout. See its README and LICENSE for details.
