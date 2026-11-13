import { Menu, type BrowserWindow } from "electron";
import { translateUi, type InterfaceLanguage } from "../shared/interface-language.js";

export function installImageContextMenu(window: BrowserWindow, getLanguage: () => InterfaceLanguage): void {
  const contents = window.webContents;
  contents.on("context-menu", (_event, params) => {
    if (params.mediaType !== "image" || !params.hasImageContents) return;
    Menu.buildFromTemplate([{
      label: translateUi("Копировать", getLanguage()),
      click: () => {
        if (!contents.isDestroyed()) contents.copyImageAt(params.x, params.y);
      },
    }]).popup({ window });
  });
}
