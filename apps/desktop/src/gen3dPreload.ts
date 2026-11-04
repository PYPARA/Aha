import { contextBridge, ipcRenderer } from "electron";

// This isolated compiler has no application bridge, filesystem API or credentials.
contextBridge.exposeInMainWorld("gen3dCompiler", {
  onTask: (callback: (task: unknown) => void) => {
    ipcRenderer.once("gen3d:task", (_event, task: unknown) => callback(task));
  },
  ready: () => ipcRenderer.send("gen3d:ready"),
  complete: (result: unknown) => ipcRenderer.send("gen3d:complete", result),
});
