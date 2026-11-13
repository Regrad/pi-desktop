import type { ConversationPlanning } from "../../shared/types.js";
export function readDesktopPlanning(): ConversationPlanning | undefined;
export function desktopPlanningLocked(): boolean;
export function assertPlanningModelAccess(): void;
export function guardExtensionHandler<T extends (...args: any[]) => any>(event: string, handler: T, source?: string): T;
