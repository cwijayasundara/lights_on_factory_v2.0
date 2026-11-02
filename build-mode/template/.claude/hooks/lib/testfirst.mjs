// Tests must accompany code: at Stop, every source-changing commit must be covered by a commit that touches tests,
// either itself or a later one. Pure: commits are [{ sha, subject, files }] oldest first.
// Curable by design: history cannot be rewritten (rebase and amend are denied), so the agent clears a finding by
// adding a commit with tests, never by editing the past. Refactor, chore, docs and style commits are exempt.
// This proves tests exist for the change, not that they were written first; ordering stays a convention.
const EXEMPT = /^(refactor|chore|docs|style)(\(.+\))?!?:/i

const under = (file, roots) => roots.some(root => file === root.replace(/\/$/, '') || file.startsWith(root.endsWith('/') ? root : `${root}/`))

export function untestedCommits(commits, sources = [], testPaths = []) {
  if (sources.length === 0 || testPaths.length === 0) return []
  let pending = []
  for (const commit of commits) {
    if (commit.files.some(file => under(file, testPaths))) pending = []
    if (EXEMPT.test(commit.subject)) continue
    if (commit.files.some(file => under(file, sources) && !under(file, testPaths))) {
      if (!commit.files.some(file => under(file, testPaths))) pending.push(`${commit.sha.slice(0, 7)} ${commit.subject}`)
    }
  }
  return pending
}
