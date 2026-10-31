// `sdlc slice` (harness readiness 1.4): a golden slice per stack, as data under templates/slices/<stack>/: a small exemplar feature in the
// stack's own idiom, the layers it follows and the rules text that explains them. `gen` writes a path-scoped Claude Code rule (so the model sees
// the exemplar's conventions only when it works on matching files) and proposes the layers for a person to approve; `scaffold <name>` writes a new
// feature from the exemplar. Nothing is ever overwritten, and nothing is enforced that a person has not approved.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, SENSORS_PATH, PLUGIN_ROOT, out, fail, read, readJson, exists, sanctionWrites, type Args } from './core.ts'
import { parseRegistry } from './registry.ts'
import { ARCH_REL } from './product.ts'
import { parseLayers, approvedDef, layerState, layerStateText } from './arch.ts'

type Slice = { stack: string; paths: string[]; layers: string[]; test: string; needs?: { file: string; json: string; equals: string; note: string }[] }
const RULES_FILE = '.claude/rules/rig-slice.md'
const MARK = '<!-- rig:slice'
const RESERVED = ['domain', 'app', 'infra', 'http', 'src', 'test', 'tests']

const stackOf = (): string => parseRegistry(read(SENSORS_PATH)).registry.stack ?? ''

function loadSlice(stack: string): { slice: Slice; rules: string; files: { rel: string; text: string }[] } | null {
  const dir = path.join(PLUGIN_ROOT, 'templates', 'slices', stack)
  if (!stack || !exists(path.join(dir, 'slice.json'))) return null
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
  return {
    slice: JSON.parse(read(path.join(dir, 'slice.json'))) as Slice,
    rules: read(path.join(dir, 'RULES.md')),
    files: walk(path.join(dir, 'files')).map(f => ({ rel: path.relative(path.join(dir, 'files'), f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') })),
  }
}

const block = (s: Slice): string => `\`\`\`rig-layers\n${s.layers.join('\n')}\n\`\`\`\n`
const noSlice = (stack: string): string => `no golden slice for ${stack ? `the "${stack}" stack` : 'this repo (no stack in .rig/sensors.json)'}: slices exist under templates/slices/<stack>/`

// A hyphen is a word boundary to the layering sensor, so a name holding a layer word (`http-client`) would make the scaffold break its own layers.
const LAYER_WORDS = ['domain', 'app', 'infra', 'http']
const PY_KEYWORDS = ['false', 'none', 'true', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case', 'type']
// Top-level names the test's `sys.path` entry for src/ would put ahead of the real module.
const PY_SHADOWS = ['json', 'logging', 'types', 'random', 'queue', 'email', 'string', 'time', 'math', 'os', 'sys', 're', 'io', 'copy', 'enum', 'abc', 'csv', 'ast', 'uuid', 'http', 'unittest', 'typing', 'datetime', 'decimal', 'pathlib', 'collections', 'functools', 'itertools', 'socket', 'select', 'signal', 'secrets', 'statistics', 'sqlite3', 'urllib', 'xml', 'html', 'code', 'dis', 'test', 'token', 'tokenize', 'symbol', 'struct', 'array', 'heapq', 'bisect', 'calendar', 'cmd', 'site', 'platform', 'operator', 'numbers', 'hashlib', 'hmac', 'base64', 'shutil', 'tempfile', 'glob', 'fnmatch', 'pickle', 'shelve', 'zlib', 'gzip', 'zipfile', 'tarfile', 'ssl', 'smtplib', 'threading', 'multiprocessing', 'subprocess', 'asyncio', 'contextlib', 'dataclasses', 'inspect', 'importlib', 'warnings', 'weakref', 'textwrap', 'difflib', 'pprint', 'reprlib', 'traceback', 'trace', 'timeit', 'profile', 'pdb', 'argparse', 'getopt', 'locale', 'gettext', 'configparser', 'codecs', 'unicodedata', 'ipaddress', 'mailbox', 'imaplib', 'poplib', 'ftplib', 'telnetlib', 'wsgiref', 'cgi', 'turtle', 'tkinter', 'curses', 'readline', 'ctypes', 'venv', 'zipapp', 'sched', 'shlex', 'stat', 'tty', 'pty', 'pwd', 'grp', 'resource', 'syslog', 'termios', 'fcntl', 'mmap', 'errno', 'gc', 'atexit', 'builtins', 'copyreg', 'keyword', 'linecache', 'marshal', 'opcode', 'pickletools', 'pkgutil', 'plistlib', 'quopri', 'rlcompleter', 'runpy', 'selectors', 'sndhdr', 'stringprep', 'sysconfig', 'tabnanny', 'this', 'wave', 'webbrowser', 'winreg', 'xdrlib', 'zoneinfo']
export function nameProblem(name: string, stack = ''): string | null {
  if (!/^[a-z][a-z0-9-]{2,30}$/.test(name) || name.endsWith('-') || name.includes('--') || RESERVED.includes(name)) return `"${name}" is not a usable feature name: 3 to 31 lowercase letters, digits and single hyphens, starting with a letter, and not one of ${RESERVED.join(', ')}`
  const word = name.split('-').find(w => LAYER_WORDS.includes(w))
  if (word) return `"${name}" contains the layer word "${word}": the layering check reads a hyphen as a word boundary, so the scaffold would break its own layers; pick another name`
  const snake = name.replace(/-/g, '_')
  if (stack === 'python' && (PY_KEYWORDS.includes(snake) || PY_SHADOWS.includes(snake))) return `"${name}" is a Python keyword or a standard-library module name, which the package would shadow; pick another name`
  return null
}
export function names(name: string): { kebab: string; snake: string; pascal: string } {
  return { kebab: name, snake: name.replace(/-/g, '_'), pascal: name.split('-').map(w => w[0]?.toUpperCase() + w.slice(1)).join('') }
}
const fill = (t: string, n: ReturnType<typeof names>): string => t.replaceAll('{{name}}', n.kebab).replaceAll('{{snake}}', n.snake).replaceAll('{{Name}}', n.pascal)

function gen(): void {
  const stack = stackOf(), loaded = loadSlice(stack)
  if (!loaded) return out(noSlice(stack))
  const rulesPath = path.join(ROOT, RULES_FILE)
  if (exists(rulesPath) && !read(rulesPath).includes(MARK)) fail(`${RULES_FILE} exists and was not written by rig: not overwriting it; move or delete it, then rerun`)
  const frontmatter = `---\npaths:\n${loaded.slice.paths.map(p => `  - "${p}"`).join('\n')}\n---\n`
  fs.mkdirSync(path.dirname(rulesPath), { recursive: true })
  fs.writeFileSync(rulesPath, `${frontmatter}${MARK} stack=${stack}. Written by \`sdlc slice gen\`; rerun it to refresh. -->\n${loaded.rules}`)
  const written = [RULES_FILE]
  const lines = [`wrote ${RULES_FILE}: Claude Code loads it when the model works on ${loaded.slice.paths.join(', ')}.`]
  const archFile = path.join(ROOT, ARCH_REL)
  if (parseLayers(read(archFile)).def) lines.push('architecture.md already declares layers: left as it is. The slice\'s layers are in templates/slices/' + stack + '/slice.json.')
  else {
    fs.mkdirSync(path.dirname(archFile), { recursive: true })
    const text = read(archFile).trimEnd() || '# Architecture'
    // An existing "## Layers" heading with no block (the architect's prose) gets the block under it, not a second heading.
    fs.writeFileSync(archFile, /^## Layers[ \t]*$/m.test(text) ? text.replace(/^## Layers[ \t]*$/m, `## Layers\n\n${block(loaded.slice).trimEnd()}`) + '\n' : `${text}\n\n## Layers\n\n${block(loaded.slice)}`)
    written.push(ARCH_REL)
    lines.push(`proposed the slice's layers under "## Layers" in .rig/product/architecture.md. Nothing is enforced until a person reviews them and runs \`sdlc.ts arch approve\`${layerState().state === 'none' ? '.' : '; the rules approved earlier still apply until then.'}`)
  }
  sanctionWrites(written)
  out(lines.join('\n'))
}

function scaffold(args: Args): void {
  const stack = stackOf(), loaded = loadSlice(stack)
  if (!loaded) return fail(noSlice(stack))
  const bad = nameProblem(args.pos[1] ?? '', stack)
  if (bad) fail(bad)
  const n = names(args.pos[1] ?? '')
  // A repo whose approved layers contradict the slice's would be scaffolded into a layout it forbids: each slice layer must be there with the
  // same glob, and the repo must allow at least every dependency the slice makes.
  const sliceDef = parseLayers(block(loaded.slice)).def
  const mine = approvedDef()
  if (mine && sliceDef) {
    const problems = sliceDef.layers.flatMap(l => {
      const theirs = mine.layers.find(x => x.name === l.name)
      if (!theirs || theirs.glob !== l.glob) return [`layer ${l.name} ${l.glob}`]
      const lacks = (sliceDef.allow[l.name] ?? []).filter(d => !(mine.allow[l.name] ?? []).includes(d))
      return lacks.length ? [`allow ${l.name} -> ${lacks.join(', ')}`] : []
    })
    if (problems.length) fail(`this repo's approved layers do not include the slice's (${problems.join('; ')}), so a scaffold would contradict them: run \`slice gen\` and \`arch approve\` for the slice's layers, or lay the feature out by hand`)
  }
  const targets = loaded.files.map(f => ({ rel: fill(f.rel, n), text: fill(f.text, n) }))
  // lstat, not exists: a dangling symlink at a target would otherwise be written through.
  const taken = (p: string): boolean => { try { fs.lstatSync(path.join(ROOT, p)); return true } catch { return false } }
  const there = targets.filter(t => taken(t.rel))
  if (there.length) fail(`not overwriting: ${there.map(t => t.rel).join(', ')} already exist${there.length === 1 ? 's' : ''}`)
  const made: string[] = []
  // The directories this run will create, so a failure can take them away again along with the files.
  const dirs = new Set<string>()
  for (const t of targets) for (let d = path.dirname(t.rel); d !== '.' && !exists(path.join(ROOT, d)); d = path.dirname(d)) dirs.add(d)
  try {
    for (const t of targets) { fs.mkdirSync(path.dirname(path.join(ROOT, t.rel)), { recursive: true }); fs.writeFileSync(path.join(ROOT, t.rel), t.text, { flag: 'wx' }); made.push(t.rel) }
  } catch (e) {
    for (const rel of made) fs.rmSync(path.join(ROOT, rel), { force: true })
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) { try { fs.rmdirSync(path.join(ROOT, d)) } catch { /* not empty, or not ours */ } }
    fail(`scaffold stopped and removed what it wrote: ${e instanceof Error ? e.message : String(e)}`)
  }
  const notes = (loaded.slice.needs ?? []).filter(n => { const j = readJson<Record<string, unknown> | null>(path.join(ROOT, n.file), null); return j !== null && j[n.json] !== n.equals }).map(n => `note: ${n.note}`)
  out([`scaffolded ${n.kebab} (${stack} slice):`, ...targets.map(t => `  ${t.rel}`), ...notes, `Run the tests: ${loaded.slice.test}`].join('\n'))
}

export function cmdSlice(args: Args): void {
  const sub = args.pos[0]
  if (sub === 'gen') return gen()
  if (sub === 'scaffold') return scaffold(args)
  if (sub === 'status') {
    const stack = stackOf()
    return out([`stack: ${stack || 'none'}`, loadSlice(stack) ? `slice: templates/slices/${stack}` : noSlice(stack), `rules file: ${exists(path.join(ROOT, RULES_FILE)) ? RULES_FILE : 'not written (run slice gen)'}`, `layers: ${layerStateText(layerState())}`].join('\n'))
  }
  fail('usage: slice (gen | scaffold <name> | status)')
}
