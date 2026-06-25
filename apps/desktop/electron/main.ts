import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createDesktopMockService } from "./desktopService.ts";
import { registerOrislopIpcHandlers } from "./ipcHandlers.ts";

const currentDir = dirname(fileURLToPath(import.meta.url));

function storagePath(): string {
  return process.env.ORISLOP_STORAGE_PATH ?? app.getPath("userData");
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "Orislop Browser",
    backgroundColor: "#f6f7f9",
    webPreferences: {
      preload: join(currentDir, "preload.ts"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.loadFile(join(currentDir, "../src/index.html"));
  return window;
}

app.whenReady().then(() => {
  const service = createDesktopMockService({
    storagePath: storagePath()
  });
  registerOrislopIpcHandlers(ipcMain, service);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
