import { defineConfig } from 'astro/config';

// Static site for Cloudflare Pages (spec §4). No adapter, no server code.
export default defineConfig({
  site: 'https://shaarhayichudstudydemo.pages.dev',
  output: 'static',
  trailingSlash: 'always',
  build: { format: 'directory' },
  devToolbar: { enabled: false },
});
