import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const api = process.env.VITE_PROXY_TARGET ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Main chunk is ~175 kB gzipped (React, router, query, socket.io, luxon); FullCalendar is split out.
  build: { chunkSizeWarningLimit: 700 },
  server: {
    port: 5173,
    proxy: {
      '/api': api,
      '/socket.io': { target: api, ws: true },
    },
  },
});
