import { defineConfig } from 'eslint/config';
export default defineConfig({ ignores: ['ignored.js'] }, {
  files: ['**/*.js'],
  rules: { 'no-unused-vars': 'error', semi: ['error', 'always'] }
});
