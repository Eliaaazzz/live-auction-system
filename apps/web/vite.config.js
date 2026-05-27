import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const API_BASE = env.VITE_API_BASE || 'http://localhost:8080';
  const WS_BASE  = env.VITE_WS_BASE  || 'ws://localhost:8080';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      host: true,
      proxy: {
        // REST — forward /api/* to the backend
        '/api': {
          target: API_BASE,
          changeOrigin: true,
        },
        // WebSocket — forward /ws to the backend
        '/ws': {
          target: WS_BASE,
          ws: true,
          changeOrigin: true,
        },
      },
    },
    build: {
      target: 'es2020',
      sourcemap: true,
    },
  };
});
