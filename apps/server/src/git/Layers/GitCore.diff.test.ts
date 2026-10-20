// Focused core regressions retained from Synara v1.0.7; unrelated upstream suites are excluded.
// FILE: GitCore.test.ts
// Purpose: Exercises GitCore repository operations, branch/worktree flows, and status summaries.
// Layer: Server Git service tests
// Depends on: Effect test layers plus real temporary Git repositories.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer, PlatformError, Scope } from "effect";
import { TestClock } from "effect/testing";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { describe, expect } from "vitest";
import { ServerConfig } from "../../config.ts";
import { GitCommandError } from "../Errors.ts";
import { GitCore, type GitCoreShape } from "../Services/GitCore.ts";
import { GitCoreLive, makeGitCore } from "./GitCore.ts";
// ── Helpers ──
const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "synara-git-core-test-",
});
const GitCoreTestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);
const TestLayer = Layer.mergeAll(NodeServices.layer, GitCoreTestLayer);
function makeTmpDir(
  prefix = "git-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}
function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}
function readTextFile(
  filePath: string,
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFileString(filePath);
  });
}
/** Run a raw git command for test setup (not under test). */
function git(
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string, GitCommandError, GitCore> {
  return Effect.gen(function* () {
    const gitCore = yield* GitCore;
    const result = yield* gitCore.execute({
      operation: "GitCore.test.git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10000,
    });
    return result.stdout.trim();
  });
}
const makeIsolatedGitCore = (executeOverride: GitCoreShape["execute"]) =>
  makeGitCore({ executeOverride }).pipe(
    Effect.provide(Layer.provideMerge(ServerConfigLayer, NodeServices.layer)),
  );
/** Create a repo with an initial commit so branches work. */
function initRepoWithCommit(cwd: string): Effect.Effect<
  {
    initialBranch: string;
  },
  GitCommandError | PlatformError.PlatformError,
  GitCore | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    yield* core.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(path.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    const initialBranch = yield* git(cwd, ["branch", "--show-current"]);
    return { initialBranch };
  });
}
// ── Tests ──
it.layer(TestLayer)("git integration", (it) => {
  describe("raw patches with configured diff prefixes", () => {
    it.effect("keeps a/ and b/ prefixes on parsed, applied and stored patches", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["config", "core.autocrlf", "false"]);
        // `diff.noprefix` drops the prefixes git apply strips; `diff.mnemonicPrefix` swaps them;
        // `color.diff=always` writes escape codes that git apply rejects.
        yield* git(tmp, ["config", "diff.noprefix", "true"]);
        yield* git(tmp, ["config", "diff.mnemonicPrefix", "true"]);
        yield* git(tmp, ["config", "color.diff", "always"]);
        const core = yield* GitCore;
        yield* core.createBranch({ cwd: tmp, branch: "feature/prefixed-patches" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "feature/prefixed-patches" });
        yield* writeTextFile(path.join(tmp, "branch.txt"), "branch change\n");
        yield* git(tmp, ["add", "branch.txt"]);
        yield* git(tmp, ["commit", "-m", "branch change"]);
        yield* writeTextFile(path.join(tmp, "staged.txt"), "staged change\n");
        yield* git(tmp, ["add", "staged.txt"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "unstaged change\n");
        const patches = yield* Effect.all({
          unstaged: core.readUnstagedPatch(tmp),
          staged: core.readStagedPatch(tmp),
          workingTree: core.readWorkingTreePatch(tmp),
          branch: core.readBranchPatch(tmp),
          ref: core.readRefPatch(tmp, initialBranch),
        });
        expect(patches.unstaged.patch).toContain("diff --git a/README.md b/README.md");
        expect(patches.staged.patch).toContain("diff --git a/staged.txt b/staged.txt");
        expect(patches.workingTree.patch).toContain("diff --git a/README.md b/README.md");
        expect(patches.branch.patch).toContain("diff --git a/branch.txt b/branch.txt");
        // New files take the `--no-index` read, so README.md covers the tracked ref diff.
        expect(patches.ref.patch).toContain("diff --git a/branch.txt b/branch.txt");
        expect(patches.ref.patch).toContain("diff --git a/README.md b/README.md");
        const wtPath = path.join(tmp, "wt-prefixed-copy");
        yield* core.createDetachedWorktree({
          cwd: tmp,
          ref: "HEAD",
          path: wtPath,
          copyChangesFrom: tmp,
        });
        expect(yield* readTextFile(path.join(wtPath, "README.md"))).toBe("unstaged change\n");
        const snapshotRoot = yield* makeTmpDir("prefixed-worktree-snapshot-test-");
        const outputPath = path.join(snapshotRoot, "snapshot");
        yield* core.snapshotWorktree({ cwd: tmp, outputPath });
        expect(yield* readTextFile(path.join(outputPath, "changes.patch"))).toMatch(
          /^diff --git a\/README\.md b\/README\.md$/m,
        );
        yield* core.removeWorktree({ cwd: tmp, path: wtPath, force: true });
      }),
    );
  });
  // ── Full flow: thread switching simulation ──
  // ── Full flow: checkout conflict ──
  describe("GitCore", () => {
    for (const useGitFallback of [false, true]) {
      it.effect(
        `surfaces untracked numstat read failures (${useGitFallback ? "Git fallback" : "fast path"})`,
        () =>
          Effect.gen(function* () {
            const realCore = yield* GitCore;
            const tmp = yield* makeTmpDir();
            yield* initRepoWithCommit(tmp);
            if (useGitFallback) yield* git(tmp, ["config", "core.bigFileThreshold", "1024"]);
            // Git cannot diff a directory against /dev/null either.
            yield* Effect.promise(() => fs.mkdir(path.join(tmp, "not-a-file")));
            const core = yield* makeIsolatedGitCore((input) =>
              input.operation.endsWith(".untrackedFiles")
                ? Effect.succeed({ code: 0, stdout: "not-a-file\0", stderr: "" })
                : realCore.execute(input),
            );
            const result = yield* Effect.result(core.readDiffStats(tmp, "unstaged"));
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure") {
              expect(result.failure).toMatchObject({
                _tag: "GitCommandError",
                operation: "GitCore.readDiffStats.untrackedNumstat",
              });
              expect(result.failure.detail).toContain("not-a-file");
            }
          }),
      );
    }
    it.effect("counts untracked numstats in-process with Git's numstat semantics", () =>
      Effect.gen(function* () {
        const realCore = yield* GitCore;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const fileSystem = yield* FileSystem.FileSystem;
        yield* writeTextFile(path.join(tmp, "text.txt"), "one\ntwo\nthree\n");
        yield* writeTextFile(path.join(tmp, "no-trailing-newline.txt"), "one\ntwo");
        yield* writeTextFile(path.join(tmp, "empty.txt"), "");
        yield* fileSystem.writeFile(path.join(tmp, "binary.bin"), new Uint8Array([1, 0, 2, 10]));
        // Git sniffs only the first 8000 bytes for NUL.
        const lateNul = new Uint8Array(9000).fill(97);
        lateNul[8500] = 0;
        lateNul[8999] = 10;
        yield* fileSystem.writeFile(path.join(tmp, "late-nul.txt"), lateNul);
        yield* writeTextFile(path.join(tmp, "locked.lock"), "a\nb\n");
        yield* fileSystem.writeFile(
          path.join(tmp, "forced-text.txt"),
          new Uint8Array([97, 0, 10, 98, 10]),
        );
        yield* fileSystem.writeFile(path.join(tmp, "driver-text.txt"), new Uint8Array([97, 0, 10]));
        yield* writeTextFile(path.join(tmp, "driver-binary.txt"), "a\nb\n");
        yield* writeTextFile(
          path.join(tmp, ".gitattributes"),
          "*.lock -diff\nforced-text.txt diff\ndriver-text.txt diff=customtext\ndriver-binary.txt diff=custombinary\n",
        );
        yield* git(tmp, ["config", "diff.customtext.binary", "false"]);
        yield* git(tmp, ["config", "diff.custombinary.binary", "true"]);
        yield* git(tmp, ["add", ".gitattributes"]);
        yield* git(tmp, ["commit", "-m", "attributes"]);
        yield* Effect.promise(() => fs.symlink("text.txt", path.join(tmp, "link")));
        yield* writeTextFile(path.join(tmp, "vanished.txt"), "gone\n");
        const commands: string[][] = [];
        const core = yield* makeIsolatedGitCore((input) => {
          commands.push([...input.args]);
          return realCore
            .execute(input)
            .pipe(
              Effect.tap(() =>
                input.operation.endsWith(".untrackedFiles")
                  ? Effect.promise(() => fs.rm(path.join(tmp, "vanished.txt")))
                  : Effect.void,
              ),
            );
        });
        // Expected values are what `git diff --no-index --numstat` reports.
        const expected = new Map([
          ["binary.bin", "-\t-"],
          ["empty.txt", "0\t0"],
          ["forced-text.txt", "2\t0"],
          ["driver-text.txt", "1\t0"],
          ["driver-binary.txt", "-\t-"],
          ["late-nul.txt", "1\t0"],
          ["link", "1\t0"],
          ["locked.lock", "-\t-"],
          ["no-trailing-newline.txt", "2\t0"],
          ["text.txt", "3\t0"],
        ]);
        for (const [filePath, counts] of expected) {
          const gitOutput = yield* realCore.execute({
            operation: "test.noIndexNumstat",
            cwd: tmp,
            args: ["diff", "--no-index", "--numstat", "-z", "--", "/dev/null", filePath],
            allowNonZeroExit: true,
          });
          expect(gitOutput.stdout).toBe(`${counts}\t\0/dev/null\0${filePath}\0`);
        }
        commands.length = 0;
        expect(yield* core.readDiffStats(tmp, "unstaged")).toEqual({
          additions: 0 + 1 + 1 + 2 + 3 + 2 + 1,
          deletions: 0,
          fileCount: expected.size,
        });
        expect(
          commands.filter((args) => args.includes("--no-index")).map((args) => args.at(-1)),
        ).toEqual(["driver-binary.txt", "driver-text.txt", "forced-text.txt", "locked.lock"]);
        expect(commands.filter((args) => args[0] === "check-attr")).toHaveLength(1);
      }),
    );
    for (const fallback of ["attribute", "threshold"] as const) {
      it.effect(`skips a vanished untracked file during the ${fallback} Git fallback`, () =>
        Effect.gen(function* () {
          const realCore = yield* GitCore;
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          if (fallback === "attribute") {
            yield* writeTextFile(path.join(tmp, ".gitattributes"), "vanished.txt diff\n");
            yield* git(tmp, ["add", ".gitattributes"]);
            yield* git(tmp, ["commit", "-m", "attributes"]);
          } else {
            yield* git(tmp, ["config", "core.bigFileThreshold", "1024"]);
          }
          yield* writeTextFile(path.join(tmp, "vanished.txt"), "gone\n");
          const core = yield* makeIsolatedGitCore((input) => {
            if (input.operation.endsWith(".untrackedNumstat")) {
              return Effect.promise(() => fs.rm(path.join(tmp, "vanished.txt"))).pipe(
                Effect.andThen(realCore.execute(input)),
              );
            }
            return realCore.execute(input);
          });
          expect(yield* core.readDiffStats(tmp, "unstaged")).toEqual({
            additions: 0,
            deletions: 0,
            fileCount: 0,
          });
        }),
      );
    }
    it.effect("honors a configured Git large-file threshold for untracked totals", () =>
      Effect.gen(function* () {
        const core = yield* GitCore;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["config", "core.bigFileThreshold", "1"]);
        yield* writeTextFile(path.join(tmp, "large.txt"), "one\ntwo\n");
        const raw = yield* core.execute({
          operation: "test.noIndexNumstat",
          cwd: tmp,
          args: ["diff", "--no-index", "--numstat", "--", "/dev/null", "large.txt"],
          allowNonZeroExit: true,
        });
        expect(raw.stdout).toBe("-\t-\t/dev/null => large.txt\n");
        expect(yield* core.readDiffStats(tmp, "unstaged")).toEqual({
          additions: 0,
          deletions: 0,
          fileCount: 1,
        });
      }),
    );
    for (const method of ["statusDetails", "readActionStatus"] as const) {
      it.effect(`bounds ${method} when a filesystem monitor stalls Git status`, () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const hook = path.join(tmp, ".git/hooks/fsmonitor");
          const started = path.join(tmp, ".git/fsmonitor-started");
          yield* writeTextFile(
            hook,
            "#!/bin/sh\ntouch .git/fsmonitor-started\nwhile :; do sleep 0.05; done\n",
          );
          yield* Effect.promise(() => fs.chmod(hook, 0o755));
          yield* git(tmp, ["config", "core.fsmonitor", hook]);
          const core = yield* GitCore;
          const query = yield* core[method](tmp).pipe(
            Effect.result,
            Effect.timeoutOption("35 seconds"),
            Effect.forkChild,
          );
          yield* Effect.promise(async () => {
            const deadline = Date.now() + 5000;
            while (!existsSync(started)) {
              if (Date.now() > deadline) throw new Error("Filesystem monitor did not start");
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          });
          yield* TestClock.adjust("30 seconds");
          // Process teardown uses real I/O; let it settle before advancing the
          // outer guard, which must catch a missing command deadline.
          yield* Effect.promise(async () => {
            const deadline = Date.now() + 2000;
            while (!query.pollUnsafe() && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          });
          yield* TestClock.adjust("5 seconds");
          const result = yield* Fiber.join(query);
          expect(result._tag).toBe("Some");
          if (result._tag === "Some") {
            expect(result.value._tag).toBe("Failure");
            if (result.value._tag === "Failure") {
              expect(result.value.failure.command).toContain("git status");
              expect(result.value.failure.detail).toContain("timed out");
            }
          }
        }),
      );
    }
  });
});
