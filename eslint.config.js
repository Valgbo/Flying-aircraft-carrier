import path from 'node:path';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const SRC = path.resolve(import.meta.dirname, 'src');
const A10 = path.join(SRC, 'a10');
const ENGINE = path.join(SRC, 'engine');
const A10_CORE = path.join(A10, 'core');
const A10_DATA = path.join(A10, 'data');
const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep);

/**
 * a10/boundaries — keeps the two apps apart (docs/a10/ARCHITECTURE.md §1):
 *  - src/a10 imports from outside itself only through src/engine (and src/styles CSS);
 *  - src/a10/core (the simulation) imports only core, data and the 'three' math classes;
 *  - the carrier app never imports src/a10, and src/engine never imports src/a10.
 */
const boundaries = {
  rules: {
    boundaries: {
      meta: { type: 'problem', schema: [] },
      create(context) {
        const file = context.filename;
        const inA10 = inside(file, A10);
        const inCore = inside(file, A10_CORE) || inside(file, A10_DATA);
        const inSrc = inside(file, SRC);
        function check(node, spec) {
          if (typeof spec !== 'string') return;
          if (!spec.startsWith('.')) {
            if (inCore && spec !== 'three') {
              context.report({
                node,
                message: `The simulation core may import only 'three' (math), not '${spec}'.`,
              });
            }
            return;
          }
          const target = path.resolve(path.dirname(file), spec);
          if (inA10) {
            if (inCore && !inside(target, A10_CORE) && !inside(target, A10_DATA)) {
              context.report({
                node,
                message: `src/a10/core and src/a10/data import only core and data ('${spec}').`,
              });
            } else if (
              !inside(target, A10) &&
              !inside(target, ENGINE) &&
              !inside(target, path.join(SRC, 'styles'))
            ) {
              context.report({
                node,
                message: `The A-10 app imports carrier code only through src/engine ('${spec}').`,
              });
            }
          } else if (inSrc && inside(target, A10)) {
            context.report({
              node,
              message: `The carrier app and src/engine must not import src/a10 ('${spec}').`,
            });
          }
        }
        return {
          ImportDeclaration: (n) => check(n, n.source.value),
          ExportAllDeclaration: (n) => check(n, n.source.value),
          ExportNamedDeclaration: (n) => n.source && check(n, n.source.value),
          ImportExpression: (n) => n.source.type === 'Literal' && check(n, n.source.value),
        };
      },
    },
  },
};

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'test-results', 'playwright-report', '.shots'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { a10: boundaries },
    rules: { 'a10/boundaries': 'error' },
  },
  {
    files: ['scripts/**/*.{js,mjs}', '*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
  prettier,
);
