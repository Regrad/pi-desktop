import { AsyncLocalStorage } from "node:async_hooks";
const scope = new AsyncLocalStorage();
export const getAnalysisScope = () => scope.getStore();
export const withAnalysisScope = (context, work) => scope.run({ epoch: globalThis[Symbol.for("pi.desktop.native.analysis.epoch")] ?? 0, ...context }, work);
