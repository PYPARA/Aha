// Pure IPC names: safe to bundle in the sandboxed Electron preload.
export const AHA_APPEARANCE_CHANNELS = {
  get: "aha:appearance:get",
  save: "aha:appearance:save",
  changed: "aha:appearance:changed",
  imageImport: "aha:appearance:image-import",
  imageRead: "aha:appearance:image-read",
  packagePreview: "aha:appearance:package-preview",
  builtinPreview: "aha:appearance:builtin-preview",
  directoryPreview: "aha:appearance:directory-preview",
  packageExport: "aha:appearance:package-export",
} as const;
