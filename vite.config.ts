import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  define: { 'import.meta.env.VITE_PI_ENGINE_VERSION': JSON.stringify(JSON.parse(readFileSync(new URL('./vendor/pi.upstream.json', import.meta.url), 'utf8')).version) },
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
  },
});
