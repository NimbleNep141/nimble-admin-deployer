import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// NEAR Wallet Selector and its crypto/serialization dependencies use Node's
// buffer/safe-buffer API. Vite does not polyfill those imports automatically.
// Without this, the browser can throw "Cannot read properties of undefined
// (reading 'from')" before the wallet can initialize.
export default defineConfig({
  base: './',
  plugins: [
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true,
    }),
  ],
  build: { target: 'es2022' },
});
