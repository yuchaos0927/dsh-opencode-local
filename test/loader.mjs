import { registerHooks } from 'node:module';
const map = {
  '@deepseek-ai/schemastery': new URL('./stub-schemastery.mjs', import.meta.url).href,
  '@deepseek-ai/dsh-llm': new URL('./stub-dsh-llm.mjs', import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, next) {
    if (map[specifier]) return { url: map[specifier], shortCircuit: true };
    return next(specifier, context);
  },
});
