import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';

// The public half of a throwaway RSA key. It fixes the extension id on every load:
// nbcmjckbkploiemllhkmhegjimgeimoa
// (SHA-256 of the key's DER, first 16 bytes, hex digits mapped 0-f to a-p). The private half was discarded.
const KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAjXdiWzrsMOPeeIiBLchCGCuTya3C9Wx3BpGuTeQDDE9MyRPmOMkeebwPUbTcib6J5aGSCPc2R5MyqdPCeVHLz8+lyhyAZYy2D+OI+IqbAO49Fyr/D3tXUNYGmP7cV6nEMKo0ieFdLUdRsNhkU8YoAVBryIZbiuOw+Q0tXNLu94jSh4U6OKlD/WPtXk+Ph8fWot0e/k/S4jbBUS7emH5Y+vj3GZ8QCjTA0qY5IbhWq8RdEp7KMpDmnJmhTkCO7YK0yjnOR6/+w3EX5jFUSBZzJdkSq8/hqznr9Zd0pl98MJWBY3E+R3jv7cMgA6UN+/bf9zNNO6t774Dv4jTEkjJqTwIDAQAB';

// The end-to-end build (WXT_AIRLOCK_PORT set) goes to its own folder so it never overwrites the normal build.
const e2e = process.env.WXT_AIRLOCK_PORT !== undefined;

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  outDir: e2e ? '.output-e2e' : '.output',
  vite: () => ({
    resolve: {
      alias: { '@airlock/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)) },
    },
  }),
  manifest: {
    name: 'Airlock',
    description: 'A local AI reviewer beside a GitHub pull request.',
    key: KEY,
    minimum_chrome_version: '116',
    permissions: ['sidePanel', 'storage'],
    host_permissions: ['https://github.com/*', 'http://127.0.0.1/*'],
    action: { default_title: 'Airlock' },
  },
});
