// Release check: pack both packages the way npm publish would, install the
// tarballs into an empty project, and run the installed command on a
// fixture repo, both as `git-forecast` and as `git forecast`. Run after
// `npm run build`:  node scripts/pack-test.ts
// Uses plain Node (type stripping), like the fixture scripts.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "git-forecast-pack-"));
const windows = process.platform === "win32";

function sh(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // npm is npm.cmd on Windows, which needs a shell.
  return execFileSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    shell: windows,
  });
}

console.log(`Packing into ${tmp}`);
const packed = JSON.parse(
  sh(
    "npm",
    [
      "pack",
      "--json",
      "--workspace",
      "packages/core",
      "--workspace",
      "packages/cli",
      "--pack-destination",
      tmp,
    ],
    root,
  ),
) as { filename: string; files: { path: string }[] }[];
for (const p of packed) {
  const names = p.files.map((f) => f.path);
  for (const required of ["package.json", "LICENSE"]) {
    if (!names.includes(required))
      throw new Error(`${p.filename} is missing ${required}`);
  }
  if (names.some((n) => /\.test\.|\/test\//.test(n)))
    throw new Error(`${p.filename} contains test files`);
  console.log(`  ${p.filename}: ${names.length} files`);
}
const cliPack = packed.find((p) => p.filename.startsWith("git-forecast-"));
if (!cliPack?.files.some((f) => f.path === "README.md"))
  throw new Error("the CLI package has no README.md");

const app = path.join(tmp, "app");
mkdirSync(app);
writeFileSync(
  path.join(app, "package.json"),
  '{ "name": "pack-test", "private": true }\n',
);
sh(
  "npm",
  [
    "install",
    "--no-audit",
    "--no-fund",
    ...packed.map((p) => path.join(tmp, p.filename)),
  ],
  app,
);

const fixtures = path.join(tmp, "fixtures");
execFileSync(
  process.execPath,
  [
    path.join(root, "fixtures", "build.ts"),
    "--check",
    "--out",
    fixtures,
    "conflict-step-2",
  ],
  {
    stdio: "ignore",
  },
);
const work = path.join(fixtures, "conflict-step-2", "work");
const env = {
  ...process.env,
  PATH: `${path.join(app, "node_modules", ".bin")}${path.delimiter}${process.env.PATH}`,
  NO_COLOR: "1",
};

const checks: [string, string[]][] = [
  ["git-forecast", []],
  ["git", ["forecast"]], // Git runs git-forecast from PATH
  ["git-forecast", ["sync"]],
];
for (const [command, args] of checks) {
  const out = sh(command, args, work, env);
  if (!out.includes("conflict in app.txt")) {
    throw new Error(`${command} ${args.join(" ")} printed:\n${out}`);
  }
  console.log(`  ok: ${command} ${args.join(" ")}`);
}
console.log("Pack test passed.");
