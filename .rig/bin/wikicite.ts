// Wiki citations (wiki design 2026-10-17): the forms a page may cite, the declaration a citation names, and its hash. Pure over text.
import { sha } from './core.ts'
import { escapeRe } from './model.ts'

export type Cite = { kind: 'code'; path: string; symbol?: string } | { kind: 'why'; type: 'adr' | 'commit' | 'pr'; ref: string }

const WHY = { adr: /^\d{1,6}$/, commit: /^[0-9a-f]{7,40}$/, pr: /^\d{1,7}$/ }
const SYMBOL = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/ // `Class.method` is allowed
const PATH = /^[\w@.\/-]+$/

function parseOne(tok: string): Cite | null {
  const why = /^(adr|commit|pr):(.+)$/.exec(tok)
  if (why) return WHY[why[1] as keyof typeof WHY].test(why[2]!) ? { kind: 'why', type: why[1] as 'adr' | 'commit' | 'pr', ref: why[2]! } : null
  const [p, symbol, ...rest] = tok.split('#')
  if (!p || rest.length || !PATH.test(p) || p.startsWith('/') || p.split('/').includes('..')) return null
  if (symbol === undefined) return { kind: 'code', path: p }
  return SYMBOL.test(symbol) ? { kind: 'code', path: p, symbol } : null
}

// The citations a line ends with, in order. Any malformed one, or none at the end, gives [].
export function parseCites(line: string): Cite[] {
  const tail = /((?:\s*\[[^\]\s]+\])+)\s*$/.exec(line)?.[1]
  if (!tail) return []
  const out: Cite[] = []
  for (const m of tail.matchAll(/\[([^\]\s]+)\]/g)) {
    const c = parseOne(m[1]!)
    if (!c) return []
    out.push(c)
  }
  return out
}

// One scanner for strings, templates, regex literals, comments and brackets, shared by comment stripping and span finding.
type Tok = { i: number; ch: string; kind: 'code' | 'string' | 'comment' }

const skipQuoted = (t: string, i: number): number => {
  const q = t[i]
  for (i++; i < t.length && t[i] !== q; i++) if (t[i] === '\\') i++
  return Math.min(i + 1, t.length)
}
// From just after `${`: to the matching `}`, with nested strings and templates inside.
function skipInterpolation(t: string, i: number): number {
  for (let depth = 1; i < t.length;) {
    const c = t[i]!
    if (c === '`') i = skipTemplate(t, i)
    else if (c === '"' || c === "'") i = skipQuoted(t, i)
    else { i++; if (c === '{') depth++; else if (c === '}' && --depth === 0) return i }
  }
  return t.length
}
function skipTemplate(t: string, i: number): number {
  for (i++; i < t.length;) {
    if (t[i] === '\\') i += 2
    else if (t[i] === '`') return i + 1
    else if (t[i] === '$' && t[i + 1] === '{') i = skipInterpolation(t, i + 2)
    else i++
  }
  return t.length
}
// A `/` opens a regex literal where an operand is expected; the end must close on the same line, else it is a division.
const REGEX_AFTER = new Set('(,=:[!&|?{};'.split(''))
const KEYWORD_BEFORE_REGEX = /\b(?:return|typeof|case|in|of|delete|void|throw)\s*$/
function skipRegex(t: string, i: number, prev: string): number {
  if (!(prev === '' || REGEX_AFTER.has(prev) || (/[A-Za-z]/.test(prev) && KEYWORD_BEFORE_REGEX.test(t.slice(Math.max(0, i - 12), i))))) return i
  let inClass = false
  for (let j = i + 1; j < t.length && t[j] !== '\n'; j++) {
    if (t[j] === '\\') j++
    else if (t[j] === '[') inClass = true
    else if (t[j] === ']') inClass = false
    else if (t[j] === '/' && !inClass) return j + 1
  }
  return i
}
function* scan(text: string): Generator<Tok> {
  let i = 0
  let prev = ''
  function* run(end: number, kind: Tok['kind']): Generator<Tok> { for (; i < end; i++) yield { i, ch: text[i]!, kind } }
  while (i < text.length) {
    const c = text[i]!
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); yield* run(e < 0 ? text.length : e, 'comment') }
    else if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); yield* run(e < 0 ? text.length : e + 2, 'comment') }
    else if (c === '"' || c === "'") { yield* run(skipQuoted(text, i), 'string'); prev = ')' }
    else if (c === '`') { yield* run(skipTemplate(text, i), 'string'); prev = ')' }
    else if (c === '/' && skipRegex(text, i, prev) > i) { yield* run(skipRegex(text, i, prev), 'string'); prev = ')' }
    else { yield { i, ch: c, kind: 'code' }; if (!/\s/.test(c)) prev = c; i++ }
  }
}

// Comments become one space, runs of whitespace one space.
export function normalise(text: string): string {
  let out = ''
  let inComment = false
  for (const t of scan(text)) {
    if (t.kind === 'comment') { if (!inComment) out += ' '; inComment = true } else { inComment = false; out += t.ch }
  }
  return out.replace(/\s+/g, ' ').trim()
}

export const hashText = (text: string): string => sha(normalise(text))


// Declaration heads for a name: keyword declarations, and a method head (`name(...) {` at the start of a line).
function heads(source: string, name: string): number[] {
  const n = escapeRe(name)
  const decl = new RegExp(`^[ \\t]*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\*?|class|interface|type|enum|const|let|var)\\s+${n}\\b`, 'gm')
  const method = new RegExp(`^[ \\t]*(?:(?:public|private|protected|static|async|get|set|readonly|override)\\s+)*${n}\\s*(?:<[^>\\n]*>)?\\s*\\([^\\n]*\\)\\s*(?::\\s*[^{;=\\n]+)?\\{[ \\t]*$`, 'gm')
  const at = new Set<number>()
  for (const re of [decl, method]) for (const m of source.matchAll(re)) at.add(m.index! + m[0].length - m[0].trimStart().length)
  return [...at]
}

const CONTINUES = /(?:[=,|&(+\-*/?:<]|=>)$/
const AFTER_CLOSE = /^\s*(?:=>|[{|&>])/

// From a head to the end of its declaration: the matching close of the first brace group (and any `{` that follows it, as in a
// return type or an extends clause), else the statement end.
function spanEnd(source: string, from: number): number {
  let depth = 0
  let sawBrace = false
  let last = from
  const rest = source.slice(from)
  for (const t of scan(rest)) {
    last = from + t.i
    if (t.kind !== 'code') continue
    const c = t.ch
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === '{') { depth++; sawBrace = true } else if (c === '}') {
      depth--
      if (depth === 0 && sawBrace && !AFTER_CLOSE.test(rest.slice(t.i + 1, t.i + 40))) return from + t.i + 1
    } else if (depth === 0 && (c === ';' || c === '\n')) {
      if (c === '\n') {
        const before = rest.slice(0, t.i).trimEnd()
        const after = rest.slice(t.i).trimStart()
        if (CONTINUES.test(before) || /^[|&?:.+]/.test(after) || sawBrace) continue
      }
      return from + t.i
    }
  }
  return from + (last - from) + 1
}

const JS_EXT = /\.[cm]?[jt]sx?$/
const LANG_HEADS: Record<string, (n: string) => RegExp> = {
  py: n => new RegExp(`^[ \\t]*(?:async\\s+)?(?:def|class)\\s+${n}\\b`, 'gm'),
  go: n => new RegExp(`^func\\s+(?:\\([^)]*\\)\\s*)?${n}\\b|^type\\s+${n}\\b`, 'gm'),
  rs: n => new RegExp(`^[ \\t]*(?:pub(?:\\([^)]*\\))?\\s+)?(?:(?:async|const|unsafe)\\s+)*(?:fn|struct|enum|trait|type)\\s+${n}\\b`, 'gm'),
}
const extOf = (file: string): string => /\.(\w+)$/.exec(file)?.[1] ?? ''

// Whether `#symbol` cites can resolve in this file: TS/JS and the languages with a declaration form above.
export const symbolSupported = (file: string): boolean => JS_EXT.test(file) || extOf(file) in LANG_HEADS

// A Python body runs from its def line to the next non-blank line at the same or a lower indent.
function pyEnd(source: string, from: number): number {
  const [head = '', ...rest] = source.slice(from).split('\n')
  const indent = (l: string): number => l.length - l.trimStart().length
  let end = head.length, pos = end
  for (const l of rest) { if (l.trim() && indent(l) <= indent(head)) break; pos += 1 + l.length; if (l.trim()) end = pos }
  return from + end
}

// The declaration text of `symbol`, or null when it is absent or declared more than once (overloads, shadowing). `file` picks the
// language by extension; without it, or for TS/JS, the TS/JS forms apply; a language with no forms never resolves.
export function findSymbol(source: string, symbol: string, file = ''): string | null {
  const dot = symbol.indexOf('.')
  if (dot > 0) { const owner = findSymbol(source, symbol.slice(0, dot), file); return owner === null ? null : findSymbol(owner, symbol.slice(dot + 1), file) }
  const lang = extOf(file)
  const mk = LANG_HEADS[lang]
  if (file && !JS_EXT.test(file) && !mk) return null
  const at = mk ? [...new Set([...source.matchAll(mk(escapeRe(symbol)))].map(m => m.index! + m[0].length - m[0].trimStart().length))] : heads(source, symbol)
  const start = at[0]
  if (at.length !== 1 || start === undefined) return null
  return source.slice(start, lang === 'py' ? pyEnd(source, start) : spanEnd(source, start)).trim()
}

// The hash a citation records, or null when the file is missing or the symbol does not resolve to exactly one declaration.
export function citeHash(cite: Cite & { kind: 'code' }, read: (p: string) => string | null): string | null {
  const text = read(cite.path)
  if (text === null) return null
  if (cite.symbol === undefined) return hashText(text)
  const decl = findSymbol(text, cite.symbol, cite.path)
  return decl === null ? null : hashText(decl)
}
