import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Shape phase: put the shape skill into a repository and open an interactive session on it.
// Run this before install-build-mode.ts; the operator approves the spec, then installs.
const SUBJECT = 'chore: add shape skill'
const SKILL = '.claude/skills/shape/SKILL.md'
const PROMPT = 'Invoke the shape skill and grill me, one question at a time, about what to build. Do not write code.'

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} exited ${result.status}`)
  return result.stdout.trim()
}

function real(p: string): string {
  return fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p)
}

export function startShape(target: string, factoryRoot: string): string {
  const into = real(target)
  const root = real(factoryRoot)
  if (into === root || into.startsWith(root + path.sep)) throw new Error(`refusing to shape inside the factory repository itself (${into})`)
  let top: string
  try {
    top = fs.realpathSync(git(into, ['rev-parse', '--show-toplevel']))
  } catch {
    throw new Error(`${into} is not the root of a git checkout`)
  }
  if (top !== into) throw new Error(`${into} is not the root of a git checkout`)
  const source = path.join(factoryRoot, 'build-mode/template', SKILL)
  const dest = path.join(into, SKILL)
  if (!fs.existsSync(dest) || fs.readFileSync(dest, 'utf8') !== fs.readFileSync(source, 'utf8')) {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(source, dest)
    git(into, ['add', '--', SKILL])
    if (git(into, ['status', '--porcelain', '--', SKILL]) !== '') git(into, ['commit', '-q', '-m', SUBJECT, '--', SKILL])
  }
  return into
}

function main(argv: string[]): number {
  const [target] = argv
  if (!target) {
    process.stderr.write('usage: node scripts/start-shape.ts <target>\n')
    return 2
  }
  try {
    const dir = startShape(target, path.resolve(import.meta.dirname, '..'))
    const claude = process.env.LIGHTS_ON_CLAUDE ?? 'claude'
    const result = spawnSync(claude, [PROMPT], { cwd: dir, stdio: 'inherit' })
    return result.status ?? 1
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) process.exitCode = main(process.argv.slice(2))
