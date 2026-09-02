// Minimal TOML reader, enough for Codex `config.toml`: tables, array tables, dotted and
// quoted keys, strings (basic, literal, multi-line), numbers, booleans, arrays, inline tables.
// Anything it cannot read throws; callers treat an unreadable hot file as changed.

class Reader {
  constructor(text) { this.s = text; this.i = 0; }
  peek(n = 0) { return this.s[this.i + n]; }
  eof() { return this.i >= this.s.length; }
  ws() { while (!this.eof() && (this.peek() === ' ' || this.peek() === '\t')) this.i++; }
  wsNl() {
    for (;;) {
      this.ws();
      if (this.peek() === '#') { while (!this.eof() && this.peek() !== '\n') this.i++; }
      if (this.peek() === '\n' || this.peek() === '\r') { this.i++; continue; }
      return;
    }
  }
  expect(ch) {
    if (this.peek() !== ch) throw new Error(`toml: expected ${ch} at ${this.i}`);
    this.i++;
  }
}

function readKey(r) {
  const parts = [];
  for (;;) {
    r.ws();
    if (r.peek() === '"' || r.peek() === "'") parts.push(readString(r));
    else {
      const m = /^[A-Za-z0-9_-]+/.exec(r.s.slice(r.i));
      if (!m) throw new Error(`toml: bad key at ${r.i}`);
      parts.push(m[0]);
      r.i += m[0].length;
    }
    r.ws();
    if (r.peek() === '.') { r.i++; continue; }
    return parts;
  }
}

function readString(r) {
  const q = r.peek();
  const triple = r.peek(1) === q && r.peek(2) === q;
  r.i += triple ? 3 : 1;
  if (triple && r.peek() === '\n') r.i++;
  let outStr = '';
  for (;;) {
    if (r.eof()) throw new Error('toml: unterminated string');
    const ch = r.peek();
    if (ch === q && (!triple || (r.peek(1) === q && r.peek(2) === q))) { r.i += triple ? 3 : 1; return outStr; }
    if (q === '"' && ch === '\\') {
      const esc = r.peek(1);
      const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' };
      if (esc === 'u' || esc === 'U') {
        const len = esc === 'u' ? 4 : 8;
        outStr += String.fromCodePoint(parseInt(r.s.substr(r.i + 2, len), 16));
        r.i += 2 + len;
        continue;
      }
      if (triple && (esc === '\n' || esc === ' ')) { r.i += 1; r.wsNl(); continue; }
      outStr += map[esc] ?? esc;
      r.i += 2;
      continue;
    }
    outStr += ch;
    r.i++;
  }
}

function readValue(r) {
  r.ws();
  const ch = r.peek();
  if (ch === '"' || ch === "'") return readString(r);
  if (ch === '[') {
    r.i++;
    const arr = [];
    for (;;) {
      r.wsNl();
      if (r.peek() === ']') { r.i++; return arr; }
      arr.push(readValue(r));
      r.wsNl();
      if (r.peek() === ',') r.i++;
    }
  }
  if (ch === '{') {
    r.i++;
    const obj = {};
    for (;;) {
      r.ws();
      if (r.peek() === '}') { r.i++; return obj; }
      const key = readKey(r);
      r.expect('=');
      setPath(obj, key, readValue(r));
      r.ws();
      if (r.peek() === ',') r.i++;
    }
  }
  const m = /^(true|false|[+-]?(?:inf|nan|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+)|\d{4}-\d{2}-\d{2}[T ]?[\d:.Z+-]*)/.exec(r.s.slice(r.i));
  if (!m) throw new Error(`toml: bad value at ${r.i}`);
  r.i += m[0].length;
  if (m[0] === 'true') return true;
  if (m[0] === 'false') return false;
  const num = Number(m[0].replace(/_/g, ''));
  return Number.isNaN(num) ? m[0] : num;
}

function setPath(obj, parts, value) {
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = Array.isArray(cur[p]) ? cur[p][cur[p].length - 1] : cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function getTable(root, parts, arrayTable) {
  let cur = root;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = Array.isArray(cur[p]) ? cur[p][cur[p].length - 1] : cur[p];
  }
  const last = parts[parts.length - 1];
  if (arrayTable) {
    if (!Array.isArray(cur[last])) cur[last] = [];
    const t = {};
    cur[last].push(t);
    return t;
  }
  if (typeof cur[last] !== 'object' || cur[last] === null) cur[last] = {};
  return Array.isArray(cur[last]) ? cur[last][cur[last].length - 1] : cur[last];
}

export function parseToml(text) {
  const r = new Reader(text);
  const root = {};
  let table = root;
  for (;;) {
    r.wsNl();
    if (r.eof()) return root;
    if (r.peek() === '[') {
      const arrayTable = r.peek(1) === '[';
      r.i += arrayTable ? 2 : 1;
      const key = readKey(r);
      r.expect(']');
      if (arrayTable) r.expect(']');
      table = getTable(root, key, arrayTable);
      continue;
    }
    const key = readKey(r);
    r.expect('=');
    setPath(table, key, readValue(r));
  }
}
