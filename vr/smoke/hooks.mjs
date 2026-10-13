// Node cannot resolve the bare 'xterm-headless' the browser's import map provides.
export async function resolve(spec, ctx, next) {
  if (spec === 'xterm-headless') return { url: new URL('../node_modules/@xterm/headless/lib-headless/xterm-headless.mjs', import.meta.url).href, shortCircuit: true };
  return next(spec, ctx);
}
