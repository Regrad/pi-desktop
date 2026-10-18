import { lazyModule } from "./lazy-module.js";

const load = lazyModule(() => import("@earendil-works/pi-coding-agent"));
export async function getSessionManager() {
  return (await load()).SessionManager;
}
