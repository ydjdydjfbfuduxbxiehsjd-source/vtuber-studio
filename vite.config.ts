import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    host: true, // listen on all addresses (localhost, 127.0.0.1)
    open: true  // automatically open in default browser
  }
});
