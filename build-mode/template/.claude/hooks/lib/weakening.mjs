// The no-weakening guard: which assertions did an existing test file lose?
// Language-agnostic on purpose: a line counts as an assertion if it names one (assert, expect, raises, toBe...).
const ASSERTION = /\b(assert\w*|expect|raises|toBe\w*|toEqual|should)\b/
const COMMENT = /^(#|\/\/|\/\*|\*)/

const normalise = line => line.trim().replace(/\s+/g, ' ')

function assertionLines(text) {
  return text
    .split('\n')
    .map(normalise)
    .filter(line => line && !COMMENT.test(line) && ASSERTION.test(line))
}

// Assertion lines present in `before` that `after` no longer has, as a multiset: moving one is fine,
// deleting, loosening or commenting it out is not.
export function removedAssertions(before, after) {
  const remaining = new Map()
  for (const line of assertionLines(after)) remaining.set(line, (remaining.get(line) ?? 0) + 1)
  const lost = []
  for (const line of assertionLines(before)) {
    const left = remaining.get(line) ?? 0
    if (left > 0) remaining.set(line, left - 1)
    else lost.push(line)
  }
  return lost
}
