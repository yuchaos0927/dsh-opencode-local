/**
 * Minimal stand-in for @deepseek-ai/schemastery.
 *
 * Only exists so the plugin's `Config` can be constructed and JSON-projected
 * without the Harness runtime present. It mirrors the real `toJSON()` shape
 * (a `{uid, refs}` node table whose root is `refs[uid]`) because that shape is
 * exactly what the Host's settings surface walks.
 */
let nextUid = 1;

function node(type) {
  const n = {
    type,
    meta: {},
    uid: nextUid++,
    dict: undefined,
    inner: undefined,
    default(v) { n.meta.default = v; return n; },
    min(v) { n.meta.min = v; return n; },
    max(v) { n.meta.max = v; return n; },
    step(v) { n.meta.step = v; return n; },
  };
  return n;
}

/** Serialize one node into the shared ref table the real package produces. */
function serialize(n, refs) {
  const out = { type: n.type, meta: { ...n.meta } };
  if (n.inner) out.inner = serialize(n.inner, refs);
  if (n.dict) {
    out.dict = {};
    for (const [key, child] of Object.entries(n.dict)) out.dict[key] = serialize(child, refs);
  }
  refs[n.uid] = out;
  return Object.keys(out).length;
}

function withJson(n) {
  Object.defineProperty(n, 'toJSON', {
    value() {
      const refs = {};
      serialize(n, refs);
      return { uid: n.uid, refs };
    },
    enumerable: false,
  });
  return n;
}

const Schema = {
  string: () => withJson(node('string')),
  number: () => withJson(node('number')),
  boolean: () => withJson(node('boolean')),
  array: (inner) => { const n = node('array'); n.inner = inner; return withJson(n); },
  object: (dict) => { const n = node('object'); n.dict = dict; return withJson(n); },
};

export default Schema;
