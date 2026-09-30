import path from "node:path";
import { createRequire } from "node:module";
// Bundled dependencies remain available when the portable add-on lives outside app.asar.
export const hostRequire = createRequire(process.env.PI_DESKTOP_APP_ROOT
  ? path.join(process.env.PI_DESKTOP_APP_ROOT, "package.json") : import.meta.url);
