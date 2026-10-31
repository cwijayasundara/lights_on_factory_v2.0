// `init --protect [--dry]`: make rig-check and ai-review required checks on the trunk (proposal 2026-10-27 A1, set up at init). It only adds
// to branch protection that already exists, never creates or replaces it; without protection, gh or a remote it prints the commands instead.
// --dry (the --quick and --defaults lane) never calls a write route.
import fs from 'node:fs'
import path from 'node:path'
import { git, ROOT } from './core.ts'
import { gh as ghRun } from './model.ts'

const CHECKS = ['rig-check', 'ai-review']
const SECRETS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']

const gh = (args: string[]): { ok: boolean; out: string } => {
  try { return { ok: true, out: ghRun(args) } } catch (e) { return { ok: false, out: String((e as { stderr?: string }).stderr ?? (e as Error).message) } }
}

// The remote's default branch when git knows it (origin/HEAD), else main or master, else main.
const trunk = (): string => git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])?.trim().replace(/^origin\//, '') || (['main', 'master'].find(b => git(['rev-parse', '--verify', '--quiet', b]) || git(['rev-parse', '--verify', '--quiet', `origin/${b}`])) ?? 'main')

export function protect(dry: boolean, branch = trunk()): string[] {
  const route = `repos/{owner}/{repo}/branches/${branch}/protection`
  const add = `gh api -X POST ${route}/required_status_checks/contexts ${CHECKS.map(c => `-f 'contexts[]=${c}'`).join(' ')}`
  const create = `gh api -X PUT ${route} --input - <<'EOF'\n{"required_status_checks":{"strict":true,"contexts":${JSON.stringify(CHECKS)}},"enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null}\nEOF`
  const lines: string[] = []
  // Checks that never report would block every PR: require them only once the workflow that reports them is installed.
  const installed = fs.existsSync(path.join(ROOT, '.github', 'workflows', 'rig-check.yml'))
  if (!installed && !dry) return [`.github/workflows/rig-check.yml is not installed, so nothing was made required (checks that never report would block every PR); run init --full --workflows first`]
  const now = gh(['api', `${route}/required_status_checks`])
  // Only "Branch not protected" means no protection. A protected branch with no status checks also answers 404, and the PUT below would replace its protection.
  if (!now.ok && /Branch not protected/i.test(now.out)) lines.push(`${branch} has no branch protection; nothing changed. Create it with the checks required (or in Settings > Branches):`, create)
  else if (!now.ok && /Required status checks not enabled/i.test(now.out)) lines.push(`${branch} is protected but requires no status checks; nothing changed. In Settings > Branches, edit ${branch}'s rule: turn on "Require status checks to pass" and add ${CHECKS.join(' and ')}`)
  else if (!now.ok) lines.push(`could not read ${branch}'s branch protection (gh: ${now.out.trim().split('\n')[0] ?? ''}); to require the checks, run:`, add)
  else {
    let have: string[] = []
    try { have = (JSON.parse(now.out) as { contexts?: string[] }).contexts ?? [] } catch { /* unreadable: treat as none */ }
    const missing = CHECKS.filter(c => !have.includes(c))
    if (!missing.length) lines.push(`required checks on ${branch}: ${CHECKS.join(', ')} (already required)`)
    else if (dry) lines.push(`would add required checks on ${branch}: ${CHECKS.join(', ')}; run:`, add)
    else {
      const r = gh(['api', '-X', 'POST', `${route}/required_status_checks/contexts`, ...missing.flatMap(c => ['-f', `contexts[]=${c}`])])
      lines.push(r.ok ? `required checks on ${branch}: ${CHECKS.join(', ')} (added)` : `could not add the required checks (gh: ${r.out.trim().split('\n')[0] ?? ''}); run:`, ...(r.ok ? [] : [add]))
    }
  }
  const secrets = gh(['secret', 'list'])
  if (!secrets.ok || !SECRETS.some(s => new RegExp(`^${s}\\b`, 'm').test(secrets.out))) lines.push(`no Claude credential found as a repository secret (an organisation or environment secret also works): ai-review needs gh secret set CLAUDE_CODE_OAUTH_TOKEN (from \`claude setup-token\`), or gh secret set ANTHROPIC_API_KEY`)
  return lines
}
