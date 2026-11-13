import { useSyncExternalStore } from "react";
import { normalizeInterfaceLanguage, translateUi, type InterfaceLanguage } from "../shared/interface-language.js";

let language: InterfaceLanguage = "en";
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const getLanguage = (): InterfaceLanguage => language;
export const getLocale = (): string => language === "ru" ? "ru-RU" : "en-US";
export const t = (key: string, ...values: unknown[]): string => translateUi(key, language, ...values);
export const useLanguage = (): InterfaceLanguage => useSyncExternalStore(subscribe, getLanguage, getLanguage);
export const conversationTitle = (conversation: { title: string; titleIsPlaceholder?: boolean }): string =>
  conversation.titleIsPlaceholder ? t("Новый чат") : conversation.title;

export function setLanguage(value: unknown): void {
  const next = normalizeInterfaceLanguage(value);
  document.documentElement.lang = next;
  if (next === language) return;
  language = next;
  for (const listener of listeners) listener();
}
