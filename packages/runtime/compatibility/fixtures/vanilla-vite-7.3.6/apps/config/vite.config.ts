import { defineConfig } from 'vite';

const configuredHeading: string = "Bundled Vite 7 config applied";

export default defineConfig({
  define: {
    __CONFIG_HEADING__: JSON.stringify(configuredHeading)
  }
});