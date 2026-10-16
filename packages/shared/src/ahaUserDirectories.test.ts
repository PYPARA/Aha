import { describe, expect, it } from "vitest";
import { ahaUserDirectories } from "./ahaUserDirectories";
describe("Aha user directories", () => {
  it("uses the system documents path and keeps each user-facing root separate", () => {
    expect(ahaUserDirectories("/Users/test", "/Volumes/Files/Documents", "darwin")).toEqual({
      root: "/Volumes/Files/Documents/Aha",
      chats: "/Volumes/Files/Documents/Aha/Chats",
      studio: "/Volumes/Files/Documents/Aha/Studio",
      groups: "/Volumes/Files/Documents/Aha/Groups",
      resource: "/Volumes/Files/Documents/Aha/Resource",
      sprite: "/Volumes/Files/Documents/Aha/Sprite",
    });
  });
  it("falls back to a platform-correct Documents path for standalone servers", () => {
    expect(ahaUserDirectories("C:\\Users\\test", undefined, "win32").chats).toBe(
      "C:\\Users\\test\\Documents\\Aha\\Chats",
    );
  });
});
