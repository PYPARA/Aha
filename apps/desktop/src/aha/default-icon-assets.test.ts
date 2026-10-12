import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { expect, it } from "vitest";
import sharp from "sharp";

const root = resolve(import.meta.dirname, "../../../..");
it("packages the default A artwork independently of skin icons for every flavor", async () => {
  const source = await readFile(join(root, "assets/aha/default/icon.png"));
  for (const relative of [
    "apps/desktop/resources/icon.png",
    "apps/desktop/resources/dock-icon.png",
    "apps/desktop/resources/dock-icon-dark.png",
    "apps/web/public/aha-logo.png",
  ])
    expect(await readFile(join(root, relative))).toEqual(source);
  expect(source).not.toEqual(
    await readFile(join(root, "apps/desktop/resources/aha/elation/icon.png")),
  );
});
it("ships decodable ICNS and ICO representations at the required sizes", async () => {
  const icns = await readFile(join(root, "apps/desktop/resources/icon.icns"));
  expect(icns.toString("ascii", 0, 4)).toBe("icns");
  expect(icns.readUInt32BE(4)).toBe(icns.length);
  const widths: number[] = [];
  for (let offset = 8; offset < icns.length; ) {
    const size = icns.readUInt32BE(offset + 4);
    expect(size).toBeGreaterThan(8);
    widths.push((await sharp(icns.subarray(offset + 8, offset + size)).metadata()).width!);
    offset += size;
  }
  expect(widths).toEqual(expect.arrayContaining([16, 32, 64, 128, 256, 512, 1024]));
  const ico = await readFile(join(root, "apps/desktop/resources/icon.ico"));
  expect(ico.readUInt16LE(2)).toBe(1);
  for (let index = 0; index < ico.readUInt16LE(4); index++) {
    const entry = 6 + index * 16;
    const offset = ico.readUInt32LE(entry + 12),
      size = ico.readUInt32LE(entry + 8);
    expect((await sharp(ico.subarray(offset, offset + size)).metadata()).width).toBe(
      ico[entry] || 256,
    );
  }
});
