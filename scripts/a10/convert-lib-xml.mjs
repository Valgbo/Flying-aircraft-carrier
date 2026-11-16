/**
 * Minimal XML reader for FlightGear PropertyList files (scripts/a10/convert-ac3d.mjs).
 * Reads data only: elements, attributes, text, CDATA; skips comments, declarations and
 * processing instructions. Every element keeps its 1-based source line for provenance.
 */

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => {
    if (e[0] === '#')
      return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e] ?? m;
  });
}

/**
 * @typedef {{ tag: string, attrs: Record<string,string>, children: XmlNode[], text: string,
 *   line: number, parent: XmlNode | null }} XmlNode
 */

/** Parse XML text into a tree. Returns the document element. */
export function parseXml(text, file = '') {
  let pos = 0;
  let line = 1;
  const n = text.length;
  /** @type {XmlNode} */
  const doc = { tag: '#document', attrs: {}, children: [], text: '', line: 1, parent: null };
  let cur = doc;

  function advance(to) {
    for (let k = pos; k < to; k++) if (text.charCodeAt(k) === 10) line++;
    pos = to;
  }

  while (pos < n) {
    const lt = text.indexOf('<', pos);
    if (lt < 0) {
      cur.text += decode(text.slice(pos));
      advance(n);
      break;
    }
    if (lt > pos) {
      cur.text += decode(text.slice(pos, lt));
      advance(lt);
    }
    if (text.startsWith('<!--', pos)) {
      const end = text.indexOf('-->', pos + 4);
      advance(end < 0 ? n : end + 3);
    } else if (text.startsWith('<![CDATA[', pos)) {
      const end = text.indexOf(']]>', pos + 9);
      cur.text += text.slice(pos + 9, end < 0 ? n : end);
      advance(end < 0 ? n : end + 3);
    } else if (text.startsWith('<?', pos)) {
      const end = text.indexOf('?>', pos + 2);
      advance(end < 0 ? n : end + 2);
    } else if (text.startsWith('<!', pos)) {
      const end = text.indexOf('>', pos + 2);
      advance(end < 0 ? n : end + 1);
    } else if (text.startsWith('</', pos)) {
      const end = text.indexOf('>', pos + 2);
      const tag = text.slice(pos + 2, end).trim();
      if (tag !== cur.tag)
        throw new Error(`${file}:${line}: closing </${tag}> does not match <${cur.tag}>`);
      cur.text = cur.text.trim();
      cur = cur.parent ?? doc;
      advance(end + 1);
    } else {
      // start tag (attribute values may contain '>', so scan quotes)
      let k = pos + 1;
      let quote = '';
      while (k < n) {
        const ch = text[k];
        if (quote) {
          if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '>') break;
        k++;
      }
      const inner = text.slice(pos + 1, k);
      const selfClosing = inner.endsWith('/');
      const body = selfClosing ? inner.slice(0, -1) : inner;
      const m = /^([^\s/>]+)/.exec(body);
      const tag = m ? m[1] : '';
      const attrs = {};
      const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = re.exec(body.slice(tag.length)))) attrs[a[1]] = decode(a[3] ?? a[4] ?? '');
      const node = { tag, attrs, children: [], text: '', line, parent: cur };
      cur.children.push(node);
      advance(k + 1);
      if (!selfClosing) cur = node;
    }
  }
  const root = doc.children.find((c) => c.tag);
  if (!root) throw new Error(`${file}: empty XML`);
  return root;
}

/** Children with a tag. */
export function all(node, tag) {
  return node ? node.children.filter((c) => c.tag === tag) : [];
}

/** First child with a tag (or a path a/b/c). */
export function child(node, path) {
  let cur = node;
  for (const part of path.split('/')) {
    if (!cur) return null;
    cur = cur.children.find((c) => c.tag === part) ?? null;
  }
  return cur;
}

/** Text of a child (path), or the default. */
export function text(node, path, dflt = null) {
  const c = child(node, path);
  return c ? c.text : dflt;
}

/** Number from a child (path), or the default. */
export function num(node, path, dflt = null) {
  const c = child(node, path);
  if (!c || c.text === '') return dflt;
  const v = Number(c.text.replace(',', '.'));
  return Number.isFinite(v) ? v : dflt;
}
