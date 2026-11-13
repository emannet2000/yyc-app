import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: './test/setup.js',
    // Vitest owns the frontend tests. Files importing 'node:test' run with `npm run test:node`.
    include: ['test/api.test.js', 'test/**/*.test.jsx'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'test/',
        '**/*.config.js',
      ],
    },
  },
});
