import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  optimizeDeps: { include: ['@classpulse/shared-types', '@classpulse/mqtt-contracts'] },
  build: { commonjsOptions: { include: [/node_modules/, /packages\/.*\/dist/] } },
  server: { host: '0.0.0.0', port: 5173, proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true }, '/socket.io': { target: 'http://localhost:3000', ws: true } } },
});
