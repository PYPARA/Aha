import { contextBridge, ipcRenderer } from "electron";

// This isolated compiler has no application bridge, filesystem API or credentials.
contextBridge.exposeInMainWorld("model3dCompiler", {
  onTask: (callback: (task: unknown) => void) => {
    ipcRenderer.once("model3d:task", (_event, task: unknown) => callback(task));
  },
  ready: () => ipcRenderer.send("model3d:ready"),
  complete: (result: unknown) => ipcRenderer.send("model3d:complete", result),
});
