// FILE: chatHotPath.compiler.test.ts
// Purpose: Regression guard — the chat hot-path modules must stay fully
//          compilable by React Compiler. The compiler runs with the default
//          `panicThreshold`, so a bailout is silent: the module keeps
//          rendering but loses *all* auto-memoization. Everything listed below
//          renders (or gates) a message row, a sidebar row, or a keystroke, so a
//          silent bailout here costs whole-tree re-renders while typing.
//
//          Four triggers have actually shipped in this repo, all of them cheap to
//          avoid once known:
//            1. a default value inside a parameter destructuring pattern
//               (BuildHIR AssignmentPattern) — apply defaults in the body;
//            2. a ref-typed prop read off a `props` object (`ref={props.itemRef}`),
//               which spreads the ref verdict to every later `props.x` read —
//               destructure the props instead;
//            3. any value block (`??`, `&&`, `?.`, a ternary, a conditional
//               spread) or a `throw` inside a `try` — hoist it out, or move the
//               whole block to module scope;
//            4. a hand-written `useCallback`/`useMemo` dependency list the
//               compiler cannot match to its own inferred scope — drop the manual
//               memoization and let the compiler own it.
// Layer: Web build-integrity test
// Depends on: babel-plugin-react-compiler (same plugin the Vite build uses).
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileReactModule } from "../test/reactCompiler";
interface HotPathModule {
  readonly relativePath: string;
  readonly requiredFunction?: string;
  // Exact multiset of bailout reasons that are deliberate and reviewed. Anything
  // else — including a second copy of an allowed reason — fails the test.
  readonly allowedBailoutReasons: readonly string[];
  // Pure logic modules contain no component or hook for the compiler to emit a
  // CompileSuccess for; they stay listed so a future hook/component that bails
  // is caught. Defaults to true.
  readonly requiresCompileSuccess?: boolean;
}
const HOT_PATH_MODULES: readonly HotPathModule[] = [
  { relativePath: "ChatView.tsx", requiredFunction: "ChatView", allowedBailoutReasons: [] },
  {
    relativePath: "chat/useComposerAttachmentPersistence.ts",
    requiredFunction: "useComposerAttachmentPersistence",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/ChatComposerFooter.tsx",
    requiredFunction: "ChatComposerFooter",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useChatComposerDraft.ts",
    requiredFunction: "useChatComposerDraft",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useChatTurnSubmission.ts",
    requiredFunction: "useChatTurnSubmission",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useChatQueuedTurns.ts",
    requiredFunction: "useChatQueuedTurns",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/useChatTurnExecution.ts",
    requiredFunction: "useChatTurnExecution",
    allowedBailoutReasons: [],
  },
  {
    relativePath: "chat/MessagesTimeline.tsx",
    // `useStableRows` deliberately reads and rewrites a previous-state ref inside
    // its memo to reuse row identities across streaming updates. That pattern is
    // documented in place and costs memoization only for that one small hook.
    allowedBailoutReasons: ["Cannot access refs during render"],
  },
  { relativePath: "chat/TimelineWorkEntryRow.tsx", allowedBailoutReasons: [] },
  { relativePath: "chat/InlineVisualFrame.tsx", allowedBailoutReasons: [] },
];
/**
 * These are among the largest modules in the app — a cold
 * Babel compile of it was measured at 66s while the rest of the workspace suite competed for CPU.
 * The budget only exists to stop a hang, so it is set far above the observed worst case rather
 * than near it; a tight bound here fails the suite for machine load, not for a real regression.
 */
const COMPILE_TIMEOUT_MS = 240000;
describe("chat hot-path React Compiler coverage", () => {
  for (const module of HOT_PATH_MODULES) {
    it(
      `compiles ${module.relativePath} without unexpected bailouts`,
      () => {
        const events = compileReactModule(join(import.meta.dirname, module.relativePath));
        const bailoutReasons = events
          .filter((event) => event.kind === "CompileError")
          .map((event) => event.detail?.reason ?? event.detail?.description ?? "unknown")
          .toSorted();
        // Pipeline failures (including stack overflows) do not emit CompileError.
        // A successful helper must not mask failure to compile the main component.
        expect(events.filter((event) => event.kind === "PipelineError")).toEqual([]);
        expect(bailoutReasons).toEqual(module.allowedBailoutReasons.toSorted());
        if (module.requiredFunction) {
          expect(
            events.some(
              (event) =>
                event.kind === "CompileSuccess" && event.fnName === module.requiredFunction,
            ),
          ).toBe(true);
        }
        if (module.requiresCompileSuccess !== false) {
          expect(events.some((event) => event.kind === "CompileSuccess")).toBe(true);
        }
      },
      COMPILE_TIMEOUT_MS,
    );
  }
});
