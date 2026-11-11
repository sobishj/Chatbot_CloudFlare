import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development, `npm run dev` proxies API calls to the Worker (`npm run dev` in worker/).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/health": "http://localhost:8787",
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
