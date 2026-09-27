import { defineConfig } from 'vite';

// GitHub Pages serves the site at https://<owner>.github.io/ball-factory/
export default defineConfig({
  base: '/ball-factory/',
  build: {
    target: 'es2020',
  },
});
