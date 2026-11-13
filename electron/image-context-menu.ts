import { Menu, type BrowserWindow } from "electron";

export function installImageContextMenu(window: BrowserWindow): void {
  const contents = window.webContents;
  contents.on("context-menu", (_event, params) => {
    if (params.mediaType !== "image" || !params.hasImageContents) return;
    Menu.buildFromTemplate([{
      label: "Копировать",
      click: () => {
        if (!contents.isDestroyed()) contents.copyImageAt(params.x, params.y);
      },
    }]).popup({ window });
  });
}
