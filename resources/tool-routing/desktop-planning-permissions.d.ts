import type { ConversationPlanning, ConversationAccess } from "../../shared/types.js";
export function readDesktopAccess(): ConversationAccess | undefined;
export function readDesktopPlanning(): ConversationPlanning | undefined;
export function desktopPlanningLocked(): boolean;
export function assertPlanningModelAccess(): void;
export function guardExtensionHandler<T extends (...args: any[]) => any>(event: string, handler: T, source?: string): T;
