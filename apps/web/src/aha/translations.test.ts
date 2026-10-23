import { it, expect } from "vitest";
import { copy } from "./translations";
import { resourceCopy } from "./resourceCopy";
import { spriteV5Copy } from "./spriteV5Copy";
import { model3dCopy } from "./model3dCopy";
import { imageBatchCopy } from "./imageBatchCopy";

it("never silently overrides a feature copy key with a different translation", () => {
  const overridden = Object.entries({
    resourceCopy,
    spriteV5Copy,
    imageBatchCopy,
    model3dCopy,
  }).flatMap(([file, entries]) =>
    Object.entries(entries)
      .filter(([key, value]) => copy[key] !== value)
      .map(([key, value]) => `${file}: ${key} = ${value} → ${copy[key]}`),
  );
  expect(overridden).toEqual([]);
});
