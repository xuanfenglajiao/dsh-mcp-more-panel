/**
 * A small TOML reader for Codex's project-level `.codex/config.toml`.
 *
 * It is read-only on purpose: TOML allows comments, dotted keys, inline tables
 * and quoted table segments that a writer cannot reproduce without a full
 * serializer. Codex entries are therefore never written back by this plugin;
 * they are listed and can be imported into a JSON source.
 *
 * Supported: table headers, dotted and quoted keys, basic and literal strings
 * (single- and multi-line), integers (also hex/octal/binary, `_` separators),
 * floats, booleans, arrays (nested, multi-line, trailing comma) and inline
 * tables. Dates are kept as their text. Array tables (`[[x]]`) are not
 * supported and throw with a line number rather than producing a wrong
 * command line.
 */

const BARE_KEY_RE = /[A-Za-z0-9_-]/;
const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\', e: '\x1b' };

/**
 * Parse a TOML document into plain objects.
 * @param {string} text - file content.
 * @returns {object} nested objects; arrays only as values.
 */
export function parseToml(text) {
  const source = String(text).replace(/^\uFEFF/, '');
  let pos = 0;

  const lineAt = (at) => {
    let line = 1;
    for (let i = 0; i < at && i < source.length; i += 1) if (source[i] === '\n') line += 1;
    return line;
  };
  const fail = (message, at = pos) => {
    throw new Error(`line ${lineAt(at)}: ${message}`);
  };
  const peek = (offset = 0) => source[pos + offset];
  const startsWith = (token) => source.startsWith(token, pos);

  /** Spaces and tabs only. */
  const skipSpaces = () => {
    while (peek() === ' ' || peek() === '\t') pos += 1;
  };
  const skipComment = () => {
    if (peek() === '#') while (pos < source.length && peek() !== '\n') pos += 1;
  };
  /** Spaces, comments and line breaks: the filler allowed inside arrays and between statements. */
  const skipBlank = () => {
    for (;;) {
      skipSpaces();
      skipComment();
      if (peek() === '\r' && peek(1) === '\n') pos += 2;
      else if (peek() === '\n') pos += 1;
      else return;
    }
  };
  /** After a statement only a comment may follow on the same line. */
  const expectLineEnd = () => {
    skipSpaces();
    skipComment();
    if (pos >= source.length) return;
    if (peek() === '\n') {
      pos += 1;
      return;
    }
    if (peek() === '\r' && peek(1) === '\n') {
      pos += 2;
      return;
    }
    fail(`unexpected text "${source.slice(pos, pos + 12)}"`);
  };

  function readBasicString() {
    const start = pos;
    pos += 1;
    let value = '';
    while (pos < source.length) {
      const char = peek();
      if (char === '"') {
        pos += 1;
        return value;
      }
      if (char === '\n') fail('string is not closed', start);
      if (char === '\\') {
        value += readEscape();
        continue;
      }
      value += char;
      pos += 1;
    }
    return fail('string is not closed', start);
  }

  function readEscape() {
    const next = peek(1);
    if (next in ESCAPES) {
      pos += 2;
      return ESCAPES[next];
    }
    if (next === 'u' || next === 'U') {
      const length = next === 'u' ? 4 : 8;
      const code = source.slice(pos + 2, pos + 2 + length);
      if (code.length !== length || !/^[0-9a-fA-F]+$/.test(code)) fail('bad unicode escape');
      pos += 2 + length;
      return String.fromCodePoint(parseInt(code, 16));
    }
    return fail(`unknown escape \\${next}`);
  }

  function readMultilineBasicString() {
    const start = pos;
    pos += 3;
    if (peek() === '\r' && peek(1) === '\n') pos += 2;
    else if (peek() === '\n') pos += 1;
    let value = '';
    while (pos < source.length) {
      if (startsWith('"""')) {
        // Up to two quotes may sit right before the closing delimiter.
        let quotes = 3;
        while (peek(quotes) === '"' && quotes < 5) quotes += 1;
        value += '"'.repeat(quotes - 3);
        pos += quotes;
        return value;
      }
      const char = peek();
      if (char === '\\') {
        // A backslash at the end of a line trims the break and leading whitespace.
        const rest = source.slice(pos + 1).match(/^[ \t]*\r?\n/);
        if (rest) {
          pos += 1 + rest[0].length;
          while (/[ \t\r\n]/.test(peek() ?? '')) pos += 1;
          continue;
        }
        value += readEscape();
        continue;
      }
      value += char;
      pos += 1;
    }
    return fail('multi-line string is not closed', start);
  }

  function readLiteralString() {
    const start = pos;
    pos += 1;
    const end = source.indexOf("'", pos);
    const newline = source.indexOf('\n', pos);
    if (end < 0 || (newline >= 0 && newline < end)) fail('string is not closed', start);
    const value = source.slice(pos, end);
    pos = end + 1;
    return value;
  }

  function readMultilineLiteralString() {
    const start = pos;
    pos += 3;
    if (peek() === '\r' && peek(1) === '\n') pos += 2;
    else if (peek() === '\n') pos += 1;
    const end = source.indexOf("'''", pos);
    if (end < 0) fail('multi-line string is not closed', start);
    let close = end + 3;
    while (source[close] === "'" && close - end < 5) close += 1;
    const value = source.slice(pos, close - 3);
    pos = close;
    return value;
  }

  function readKeyPart() {
    if (peek() === '"') return readBasicString();
    if (peek() === "'") return readLiteralString();
    const start = pos;
    while (pos < source.length && BARE_KEY_RE.test(peek())) pos += 1;
    if (pos === start) fail('key is missing');
    return source.slice(start, pos);
  }

  /** A dotted key: `a.b."c.d"`. */
  function readKey() {
    const parts = [];
    for (;;) {
      skipSpaces();
      parts.push(readKeyPart());
      skipSpaces();
      if (peek() !== '.') return parts;
      pos += 1;
    }
  }

  function readNumberOrDate() {
    const rest = source.slice(pos);
    const date = rest.match(/^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|^\d{2}:\d{2}:\d{2}(?:\.\d+)?/);
    if (date) {
      pos += date[0].length;
      return date[0];
    }
    const special = rest.match(/^[+-]?(inf|nan)\b/);
    if (special) {
      pos += special[0].length;
      return special[1] === 'inf' ? (special[0].startsWith('-') ? -Infinity : Infinity) : NaN;
    }
    const radix = rest.match(/^0([xob])([0-9A-Fa-f_]+)/);
    if (radix) {
      pos += radix[0].length;
      const base = { x: 16, o: 8, b: 2 }[radix[1]];
      return parseInt(radix[2].replace(/_/g, ''), base);
    }
    const number = rest.match(/^[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?/);
    if (!number) return fail('value is not a string, number, boolean, array or table');
    pos += number[0].length;
    return Number(number[0].replace(/_/g, ''));
  }

  function readArray() {
    pos += 1;
    const items = [];
    for (;;) {
      skipBlank();
      if (peek() === ']') {
        pos += 1;
        return items;
      }
      if (pos >= source.length) fail('array is not closed');
      items.push(readValue());
      skipBlank();
      if (peek() === ',') {
        pos += 1;
        continue;
      }
      if (peek() === ']') {
        pos += 1;
        return items;
      }
      fail('expected "," or "]" in an array');
    }
  }

  function readInlineTable() {
    pos += 1;
    const table = {};
    for (;;) {
      skipBlank();
      if (peek() === '}') {
        pos += 1;
        return table;
      }
      if (pos >= source.length) fail('inline table is not closed');
      const key = readKey();
      skipSpaces();
      if (peek() !== '=') fail('expected "=" in an inline table');
      pos += 1;
      skipSpaces();
      assign(table, key, readValue());
      skipBlank();
      if (peek() === ',') {
        pos += 1;
        continue;
      }
      if (peek() === '}') {
        pos += 1;
        return table;
      }
      fail('expected "," or "}" in an inline table');
    }
  }

  function readValue() {
    if (pos >= source.length || peek() === '\n' || peek() === '\r') fail('value is missing');
    if (startsWith('"""')) return readMultilineBasicString();
    if (peek() === '"') return readBasicString();
    if (startsWith("'''")) return readMultilineLiteralString();
    if (peek() === "'") return readLiteralString();
    if (peek() === '[') return readArray();
    if (peek() === '{') return readInlineTable();
    if (/^true\b/.test(source.slice(pos, pos + 5))) {
      pos += 4;
      return true;
    }
    if (/^false\b/.test(source.slice(pos, pos + 6))) {
      pos += 5;
      return false;
    }
    return readNumberOrDate();
  }

  function descend(target, key) {
    let current = target;
    for (const part of key) {
      if (current[part] === undefined) current[part] = {};
      else if (current[part] === null || typeof current[part] !== 'object' || Array.isArray(current[part])) fail(`"${part}" is not a table`);
      current = current[part];
    }
    return current;
  }

  function assign(target, key, value) {
    const parent = descend(target, key.slice(0, -1));
    parent[key[key.length - 1]] = value;
  }

  const root = {};
  let current = root;
  for (;;) {
    skipBlank();
    if (pos >= source.length) break;
    if (peek() === '[') {
      if (peek(1) === '[') fail('array tables are not supported');
      pos += 1;
      const key = readKey();
      skipSpaces();
      if (peek() !== ']') fail('table header is not closed');
      pos += 1;
      current = descend(root, key);
      expectLineEnd();
      continue;
    }
    const key = readKey();
    skipSpaces();
    if (peek() !== '=') fail('expected a table header or key = value');
    pos += 1;
    skipSpaces();
    assign(current, key, readValue());
    expectLineEnd();
  }
  return root;
}
