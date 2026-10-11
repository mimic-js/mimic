import solid from 'vite-plugin-solid';
export default {
  plugins: [solid()],
  optimizeDeps: { entries: ['index.html'] }
};