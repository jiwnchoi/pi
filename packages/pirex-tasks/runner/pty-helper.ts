import { createRequire } from "node:module";
import { accessSync, chmodSync, constants, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
/** node-pty 1.1.0 publishes its macOS prebuild helper without executable bits. */
export function preparePtyHelper(): void {
  if (process.platform !== "darwin") return;
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("node-pty/package.json"));
  for (const dir of [
    "build/Release",
    "build/Debug",
    `prebuilds/${process.platform}-${process.arch}`,
  ]) {
    const helper = join(root, dir, "spawn-helper");
    if (!existsSync(helper)) continue;
    try {
      accessSync(helper, constants.X_OK);
    } catch {
      chmodSync(helper, statSync(helper).mode | 0o111);
    }
  }
}
