import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePiLensGrammars } from "../resources/pi-lens/grammars.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await ensurePiLensGrammars(path.join(root, "node_modules", "pi-lens"));
console.log(`Pi Lens: ${result.count} grammars verified (${(result.totalBytes / 1048576).toFixed(1)} MiB).`);
