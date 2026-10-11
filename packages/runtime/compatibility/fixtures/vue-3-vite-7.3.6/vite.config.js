import vue from '@vitejs/plugin-vue';
export default {
  plugins: [vue()],
  optimizeDeps: { entries: ['index.html'] }
};