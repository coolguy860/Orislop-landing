import { contextBridge, ipcRenderer } from "electron";

const api = {
  listFixtures: () => ipcRenderer.invoke("orislop:listFixtures"),
  scoreShort: (payload: unknown) => ipcRenderer.invoke("orislop:scoreShort", payload),
  getSettings: () => ipcRenderer.invoke("orislop:getSettings"),
  updateSettings: (payload: unknown) => ipcRenderer.invoke("orislop:updateSettings", payload),
  resetSettings: () => ipcRenderer.invoke("orislop:resetSettings"),
  saveFeedback: (payload: unknown) => ipcRenderer.invoke("orislop:saveFeedback", payload),
  getCachedScore: (payload: unknown) => ipcRenderer.invoke("orislop:getCachedScore", payload),
  clearCache: () => ipcRenderer.invoke("orislop:clearCache"),
  forceRescan: (payload: unknown) => ipcRenderer.invoke("orislop:forceRescan", payload),
  getSkipHistory: () => ipcRenderer.invoke("orislop:getSkipHistory")
};

contextBridge.exposeInMainWorld("orislop", api);
