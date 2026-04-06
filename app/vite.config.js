import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  base: './',
  plugins: [
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true,
    }),
  ],
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 2500,
    commonjsOptions: { transformMixedEsModules: true },
    rollupOptions: {
      output: {
        manualChunks: {
          solana: ['@solana/kit'],
          irys: ['@irys/web-upload', '@irys/web-upload-solana'],
          arweave: ['arweave'],
        },
      },
    },
  },
});
