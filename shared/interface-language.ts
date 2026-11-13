import { englishUi } from "./ui-catalog.js";

export type InterfaceLanguage = "en" | "ru";

export function normalizeInterfaceLanguage(value: unknown): InterfaceLanguage {
  return value === "ru" ? "ru" : "en";
}

/** Translate application-owned text only. Interpolated user content stays verbatim. */
export function translateUi(key: string, language: InterfaceLanguage, ...values: unknown[]): string {
  const template = language === "en" && Object.hasOwn(englishUi, key) ? englishUi[key] : key;
  return template.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : placeholder);
}
