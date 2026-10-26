import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';
import { relay } from './relay.mjs';

// `npm run dev:headset` serves over HTTPS on your local network so a headset's browser can open it:
// WebXR needs a secure origin everywhere except localhost. Both host the room relay (relay.mjs) at
// /relay, which is what a game that plays together connects to.
export default defineConfig(({ mode }) => ({

  base: '/zombie-beat-xr/',
  plugins: mode === 'headset' ? [basicSsl(), relay()] : [relay()],
  server: { host: mode === 'headset' },
  // main.js uses top-level await.
  build: { target: 'es2022' },
}));
