import type { ImageInputReference } from "@synara/contracts";
// Expand only structured comments, never a previously expanded request snapshot.
export function imageCommentPrompt(prompt: string, references: readonly ImageInputReference[]) {
  const blocks = references.flatMap((reference, index) => {
    const comments = (reference.comments ?? []).filter((c) => c.text.trim());
    return comments.length
      ? [
          `[image ${index + 1}] notes:\n${comments.map((c, i) => `${i + 1}. (X=${Math.round(c.x * 100)}%, Y=${Math.round(c.y * 100)}%) ${c.text.trim()}`).join("\n")}`,
        ]
      : [];
  });
  return [prompt.trim(), ...blocks].filter(Boolean).join("\n\n");
}
