import { Menu, type BrowserWindow } from "electron";
import { translateUi, type InterfaceLanguage } from "../shared/interface-language.js";

export function installEditorContextMenu(window: BrowserWindow, getLanguage: () => InterfaceLanguage): void {
  window.webContents.on("context-menu", (_event, params) => {
    if (!params.isEditable) return;
    const language = getLanguage();
    Menu.buildFromTemplate([
      { role: "cut", label: translateUi("Вырезать", language), accelerator: "CmdOrCtrl+X", enabled: params.editFlags.canCut },
      { role: "copy", label: translateUi("Копировать", language), accelerator: "CmdOrCtrl+C", enabled: params.editFlags.canCopy },
      { role: "paste", label: translateUi("Вставить", language), accelerator: "CmdOrCtrl+V", enabled: params.editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll", label: translateUi("Выделить всё", language), accelerator: "CmdOrCtrl+A", enabled: params.editFlags.canSelectAll },
    ]).popup({ window });
  });
}
