/**
 * Minimal JSONC (JSON with Comments) reader + comment-preserving surgeon.
 *
 * `.code-workspace` files are JSONC: `//` line comments, block comments, and
 * trailing commas are all legal, and users routinely keep explanatory comments
 * inside them. A plain `JSON.parse` rejects such a file outright, and a
 * parse-then-`JSON.stringify` round trip silently deletes every comment.
 *
 * So this module provides two things:
 *
 *   1. {@link parseJsonc} — a lenient reader that accepts exactly what VS Code
 *      accepts (BOM, comments anywhere whitespace may appear, trailing commas)
 *      and reports a line/column on failure.
 *   2. {@link patchDocument} — a *surgical* writer that rewrites only the byte
 *      range of one top-level member's value and leaves every other byte of the
 *      original file untouched, comments included.
 *
 * The second is what makes "edit the folders list from the plugin panel" safe:
 * the file a user maintains by hand keeps its formatting, its member order, and
 * every comment that was not part of the edited member.
 *
 * Deliberately dependency-free and side-effect-free so the tests can hammer it.
 */

/** Thrown for malformed input; carries `line` and `column` (both 1-based). */
export class JsoncSyntaxError extends SyntaxError {
  constructor(message, text, offset) {
    const { line, column } = lineColumnAt(text, offset)
    super(`${message} (line ${line}, column ${column})`)
    this.name = 'JsoncSyntaxError'
    this.line = line
    this.column = column
    this.offset = offset
  }
}

/** 1-based line/column of one 0-based offset. */
function lineColumnAt(text, offset) {
  const upto = text.slice(0, Math.max(0, Math.min(offset, text.length)))
  let line = 1
  let lastBreak = -1
  for (let i = 0; i < upto.length; i++) {
    if (upto[i] === '\n') {
      line++
      lastBreak = i
    }
  }
  return { line, column: offset - lastBreak }
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v', '\u00a0', '\ufeff'])

/** Drop a leading BOM (and nothing else). */
export function stripBom(text) {
  const s = String(text)
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

/** Whether `text` begins with a BOM. */
export function hasBom(text) {
  return String(text).charCodeAt(0) === 0xfeff
}

/**
 * A cursor over the raw text. Every JSONC-specific concession lives here:
 * {@link Cursor#skipTrivia} eats whitespace *and* comments, and the collection
 * parsers accept a trailing comma.
 */
class Cursor {
  constructor(text) {
    this.text = text
    this.i = 0
  }

  err(message, at = this.i) {
    return new JsoncSyntaxError(message, this.text, at)
  }

  atEnd() {
    return this.i >= this.text.length
  }

  /** Whitespace + `//` and block comments, in any interleaving. */
  skipTrivia() {
    for (;;) {
      while (this.i < this.text.length && WHITESPACE.has(this.text[this.i])) this.i++
      if (this.text[this.i] !== '/') return
      const next = this.text[this.i + 1]
      if (next === '/') {
        this.i += 2
        while (this.i < this.text.length && this.text[this.i] !== '\n' && this.text[this.i] !== '\r') this.i++
        continue
      }
      if (next === '*') {
        const start = this.i
        this.i += 2
        while (this.i < this.text.length && !(this.text[this.i] === '*' && this.text[this.i + 1] === '/')) this.i++
        if (this.i >= this.text.length) throw this.err('Unterminated block comment', start)
        this.i += 2
        continue
      }
      // A lone '/' is not a comment start; leave it for the value parser to
      // reject with a useful message.
      return
    }
  }

  peek() {
    return this.text[this.i]
  }

  expect(ch) {
    if (this.text[this.i] !== ch) {
      throw this.err(`Expected ${JSON.stringify(ch)} but found ${this.describeHere()}`)
    }
    this.i++
  }

  describeHere() {
    if (this.atEnd()) return 'the end of the file'
    return JSON.stringify(this.text[this.i])
  }

  parseString() {
    const start = this.i
    this.expect('"')
    let out = ''
    for (;;) {
      if (this.atEnd()) throw this.err('Unterminated string', start)
      const ch = this.text[this.i]
      if (ch === '"') {
        this.i++
        return out
      }
      if (ch === '\\') {
        const esc = this.text[this.i + 1]
        this.i += 2
        switch (esc) {
          case '"': out += '"'; break
          case '\\': out += '\\'; break
          case '/': out += '/'; break
          case 'b': out += '\b'; break
          case 'f': out += '\f'; break
          case 'n': out += '\n'; break
          case 'r': out += '\r'; break
          case 't': out += '\t'; break
          case 'u': {
            const hex = this.text.slice(this.i, this.i + 4)
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw this.err('Invalid \\u escape', this.i - 2)
            out += String.fromCharCode(parseInt(hex, 16))
            this.i += 4
            break
          }
          default:
            throw this.err(`Invalid escape sequence "\\${esc ?? ''}"`, this.i - 2)
        }
        continue
      }
      if (ch === '\n' || ch === '\r') throw this.err('Unterminated string', start)
      out += ch
      this.i++
    }
  }

  parseNumber() {
    const start = this.i
    if (this.peek() === '-') this.i++
    while (isDigit(this.text[this.i])) this.i++
    if (this.peek() === '.') {
      this.i++
      while (isDigit(this.text[this.i])) this.i++
    }
    if (this.peek() === 'e' || this.peek() === 'E') {
      this.i++
      if (this.peek() === '+' || this.peek() === '-') this.i++
      while (isDigit(this.text[this.i])) this.i++
    }
    const raw = this.text.slice(start, this.i)
    const value = Number(raw)
    if (raw === '' || Number.isNaN(value)) throw this.err('Invalid number', start)
    return value
  }

  parseLiteral() {
    for (const [word, value] of [['true', true], ['false', false], ['null', null]]) {
      if (this.text.startsWith(word, this.i)) {
        this.i += word.length
        return value
      }
    }
    throw this.err(`Unexpected token ${this.describeHere()}`)
  }

  parseValue(onMember) {
    this.skipTrivia()
    const ch = this.peek()
    if (ch === '{') return this.parseObject(onMember)
    if (ch === '[') return this.parseArray()
    if (ch === '"') return this.parseString()
    if (ch === '-' || isDigit(ch)) return this.parseNumber()
    if (ch === undefined) throw this.err('Unexpected end of file')
    return this.parseLiteral()
  }

  parseObject(onMember) {
    this.expect('{')
    const out = {}
    let first = true
    for (;;) {
      this.skipTrivia()
      if (this.peek() === '}') {
        this.i++
        return out
      }
      if (!first) this.expect(',')
      first = false
      this.skipTrivia()
      if (this.peek() === '}') {
        // Trailing comma.
        this.i++
        return out
      }
      if (this.peek() !== '"') throw this.err(`Expected an object key but found ${this.describeHere()}`)
      const keyStart = this.i
      const key = this.parseString()
      const keyEnd = this.i
      this.skipTrivia()
      this.expect(':')
      this.skipTrivia()
      const valueStart = this.i
      // Nested objects never record members: only the document root passes a
      // callback, so the recorded ranges stay top-level.
      const value = this.parseValue(undefined)
      const valueEnd = this.i
      out[key] = value
      if (onMember) onMember({ key, keyStart, keyEnd, valueStart, valueEnd })
    }
  }

  parseArray() {
    this.expect('[')
    const out = []
    let first = true
    for (;;) {
      this.skipTrivia()
      if (this.peek() === ']') {
        this.i++
        return out
      }
      if (!first) this.expect(',')
      first = false
      this.skipTrivia()
      if (this.peek() === ']') {
        // Trailing comma.
        this.i++
        return out
      }
      out.push(this.parseValue(undefined))
    }
  }
}

const isDigit = (ch) => ch !== undefined && ch >= '0' && ch <= '9'

/**
 * Parse JSONC text.
 * @param text - the raw file contents (a BOM is tolerated).
 * @returns the parsed value.
 * @throws {JsoncSyntaxError} with 1-based `line`/`column` on malformed input.
 */
export function parseJsonc(text) {
  const cursor = new Cursor(stripBom(text))
  const value = cursor.parseValue(undefined)
  cursor.skipTrivia()
  if (!cursor.atEnd()) throw cursor.err(`Unexpected trailing content ${cursor.describeHere()}`)
  return value
}

/**
 * Parse a JSONC **document**: the value plus the source ranges of every
 * top-level object member, which is what {@link patchDocument} edits.
 * @param text - the raw file contents.
 * @returns `{ value, members, indent, hasBom }`.
 * @throws {JsoncSyntaxError} on malformed input, or when the root is not an object.
 */
export function parseDocument(text) {
  const source = stripBom(text)
  const cursor = new Cursor(source)
  const members = new Map()
  const value = cursor.parseValue((member) => {
    // A duplicate key keeps the LAST range, matching the value the parser kept.
    members.set(member.key, member)
  })
  cursor.skipTrivia()
  if (!cursor.atEnd()) throw cursor.err(`Unexpected trailing content ${cursor.describeHere()}`)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new JsoncSyntaxError('A workspace file must contain a JSON object at the top level', source, 0)
  }
  return { value, members, indent: detectIndent(source), hasBom: hasBom(text) }
}

/**
 * The file's own indentation style, so a rewritten value keeps looking native.
 * Tabs win when any line is tab-indented; otherwise the narrowest positive run
 * of leading spaces is used; the VS Code default is a tab.
 */
export function detectIndent(text) {
  const lines = String(text).split(/\r?\n/)
  for (const line of lines) {
    if (/^\t+/.test(line)) return '\t'
  }
  let best = null
  for (const line of lines) {
    const match = /^( +)\S/.exec(line)
    if (match === null) continue
    const width = match[1].length
    if (best === null || width < best) best = width
  }
  return ' '.repeat(best ?? 2)
}

/** Prefix every line after the first with `baseIndent`. */
function reindent(json, baseIndent) {
  if (baseIndent === '') return json
  const lines = json.split('\n')
  for (let i = 1; i < lines.length; i++) lines[i] = baseIndent + lines[i]
  return lines.join('\n')
}

/** The whitespace that precedes `offset` on its own line, or '' otherwise. */
function indentBefore(text, offset) {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1
  const prefix = text.slice(lineStart, offset)
  return /^[ \t]*$/.test(prefix) ? prefix : ''
}

/** Whether `offset` (skipping spaces/tabs) sits on a `,`. */
function commaAfter(text, offset) {
  let i = offset
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++
  return i < text.length && text[i] === ',' ? i : -1
}

/** Offset of the document root's closing `}`, scanning strings/comments correctly. */
function findRootClose(source) {
  const cursor = new Cursor(source)
  cursor.skipTrivia()
  if (cursor.peek() !== '{') {
    throw new JsoncSyntaxError('A workspace file must contain a JSON object at the top level', source, cursor.i)
  }
  let depth = 0
  let i = cursor.i
  while (i < source.length) {
    const ch = source[i]
    if (ch === '"') {
      i++
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === '"') break
        i++
      }
      i++
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  throw new JsoncSyntaxError('Unterminated object', source, source.length)
}

/** Sentinel for {@link patchDocument}: remove the addressed member. */
export const REMOVE = Symbol('jsonc.remove')

/**
 * Rewrite ONE top-level member's value in place, preserving every other byte of
 * the file — comments, member order, trailing commas, and line endings.
 *
 * The member is appended (as the last member) when absent, and removed when
 * `value` is {@link REMOVE}.
 *
 * @param text - the current file contents.
 * @param key - top-level member name, e.g. `'folders'`.
 * @param value - the new value, or {@link REMOVE}.
 * @returns the new file contents.
 * @throws {JsoncSyntaxError} when the current text is malformed.
 */
export function patchDocument(text, key, value) {
  const bom = hasBom(text) ? '\ufeff' : ''
  const source = stripBom(text)
  const { members, indent } = parseDocument(source)
  const existing = members.get(key)
  const membersInOrder = [...members.values()]

  const finish = (body) => bom + body

  if (value === REMOVE) {
    if (existing === undefined) return text
    let start = existing.keyStart
    let end = existing.valueEnd
    const lineStart = source.lastIndexOf('\n', start - 1) + 1
    const ownLine = /^[ \t]*$/.test(source.slice(lineStart, start))
    const comma = commaAfter(source, end)
    if (comma >= 0) {
      // Middle (or trailing-comma) member: take its comma and its own line.
      if (ownLine) start = lineStart
      end = comma + 1
      while (end < source.length && (source[end] === ' ' || source[end] === '\t')) end++
      if (source[end] === '\r') end++
      if (source[end] === '\n') end++
    } else {
      // Last member without a trailing comma: drop the PRECEDING comma instead.
      const prev = membersInOrder.filter((m) => m.valueEnd <= existing.valueEnd).at(-2)
      if (prev !== undefined) {
        const prevComma = commaAfter(source, prev.valueEnd)
        if (prevComma >= 0 && prevComma < existing.keyStart) {
          let cutStart = prevComma
          while (cutStart > 0 && (source[cutStart - 1] === ' ' || source[cutStart - 1] === '\t')) cutStart--
          start = cutStart
        }
      }
    }
    return finish(source.slice(0, start) + source.slice(end))
  }

  const rendered = JSON.stringify(value, null, indent)
  if (rendered === undefined) throw new TypeError(`patchDocument: ${key} is not JSON-serialisable`)

  if (existing !== undefined) {
    const base = indentBefore(source, existing.keyStart)
    return finish(source.slice(0, existing.valueStart) + reindent(rendered, base) + source.slice(existing.valueEnd))
  }

  // ---- append as the last member -------------------------------------------
  // Two ordered steps, so nothing already in the file is destroyed: give the
  // previous last member its separating comma when it lacks one, then insert the
  // new member immediately above the root's closing brace. Trivia between the
  // last member and that brace — most importantly a trailing comment — survives
  // untouched, because the insertion point is the brace's own line start.
  const rootClose = findRootClose(source)
  const last = membersInOrder.at(-1)
  const needsComma = last !== undefined && commaAfter(source, last.valueEnd) < 0

  let working = source
  let close = rootClose
  if (needsComma) {
    working = `${source.slice(0, last.valueEnd)},${source.slice(last.valueEnd)}`
    close = rootClose + 1
  }

  const closingLineStart = working.lastIndexOf('\n', close - 1) + 1
  const linePrefix = working.slice(closingLineStart, close)
  const braceOnOwnLine = /^[ \t]*$/.test(linePrefix)
  const closingIndent = braceOnOwnLine ? linePrefix : ''
  const member = `${indent}${JSON.stringify(key)}: ${reindent(rendered, indent)}`
  const insertion = braceOnOwnLine ? `${member}\n` : `\n${member}\n${closingIndent}`
  return finish(working.slice(0, braceOnOwnLine ? closingLineStart : close) + insertion + working.slice(braceOnOwnLine ? closingLineStart : close))
}

/**
 * Serialise a whole workspace document for a file that does not exist yet.
 * Uses a tab by default, matching what VS Code writes.
 * @param value - the document value.
 * @param indent - indentation unit; defaults to a tab.
 */
export function stringifyDocument(value, indent = '\t') {
  return JSON.stringify(value, null, indent) + '\n'
}
