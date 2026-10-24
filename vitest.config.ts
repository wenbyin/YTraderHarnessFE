import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': join(__dirname, 'src'),
      '@root': join(__dirname),
      '@@': join(__dirname, 'src', '.umi'),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./tests/setupTests.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // Umi 的集成测试跑不起来（依赖 @umijs/max 自带的 Jest 运行时），
    // 且模板遗留的 login.test.tsx 早已被删 —— 这里只留真正要排除的目录。
    exclude: ['node_modules', 'dist', '.umi'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/.umi/**', 'src/**/*.d.ts', 'src/**/index.style.ts'],
    },
    passWithNoTests: true,
    testTimeout: 15000,
  },
});
