// The lessons file (learning loop design 2026-10-17): `.rig/lessons.md` holds the active lessons, `.rig/lessons-archive.md` the retired and
// promoted ones. One line per lesson; any other line is a comment. A line is data for a script, so a malformed one is an error, never guessed at.
export type Status = 'active' | 'retired' | `promoted:${string}`
export type Lesson = { id: string; text: string; key: string; seen: string[]; first: string; lastFired: string; status: Status }

const MAX_WORDS = 25
const MAX_ACTIVE = 30
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const STATUS_RE = /^(?:active|retired|promoted:[a-z0-9-]+)$/
const LESSON_LINE = /^- ([A-Za-z]\w*) \| /

export const formatLesson = (l: Lesson): string =>
  `- ${l.id} | ${l.text} | key: ${l.key} | seen: ${l.seen.join(', ')} | first ${l.first} | last-fired ${l.lastFired} | ${l.status}`

export function parseLessons(text: string): { lessons: Lesson[]; errors: string[] } {
  const lessons: Lesson[] = []
  const errors: string[] = []
  for (const raw of text.split('\n')) {
    const m = LESSON_LINE.exec(raw)
    if (!m) continue
    const id = m[1] as string
    const f = raw.slice(2).split(' | ')
    const [, body, key, seen, first, last, status] = f
    if (f.length !== 7 || !key?.startsWith('key: ') || !seen?.startsWith('seen: ') || !first?.startsWith('first ') || !last?.startsWith('last-fired ')) {
      errors.push(`${id}: malformed line (7 fields separated by " | "; the lesson text cannot contain "|")`)
      continue
    }
    const l: Lesson = { id, text: body as string, key: key.slice(5), seen: seen.slice(6).split(', ').filter(Boolean), first: first.slice(6), lastFired: last.slice(11), status: status as Status }
    if (!DATE_RE.test(l.first) || !DATE_RE.test(l.lastFired)) errors.push(`${id}: date must be YYYY-MM-DD`)
    else if (!STATUS_RE.test(l.status)) errors.push(`${id}: status must be active, retired or promoted:<rule-id>`)
    else lessons.push(l)
  }
  return { lessons, errors }
}

// Every problem in the text, as messages that name the lesson; empty means it passes. `slugs` are the changes that exist.
const SESSION = /^session:[0-9a-f]{8}$/
export function checkLessons(text: string, slugs: string[]): string[] {
  const { lessons, errors } = parseLessons(text)
  const out = [...errors]
  const ids = new Set<string>()
  for (const l of lessons) {
    if (ids.has(l.id)) out.push(`duplicate id ${l.id}`)
    ids.add(l.id)
    if (!l.text.trim()) out.push(`${l.id}: the lesson text is empty`)
    if (l.text.includes('|')) out.push(`${l.id}: the lesson text cannot contain "|"`)
    if (!l.key.trim()) out.push(`${l.id}: key is empty`)
    const words = l.text.trim().split(/\s+/).filter(Boolean).length
    if (words > MAX_WORDS) out.push(`${l.id}: ${words} words, at most ${MAX_WORDS}`)
    if (new Set(l.seen).size < 2) out.push(`${l.id}: cites ${new Set(l.seen).size} change(s), at least 2 distinct changes are required`)
    // A lesson learned from the person's corrections cites `session:<8 hex>`: transcripts stay local, so the session cannot be checked here.
    for (const s of l.seen) if (!slugs.includes(s) && !SESSION.test(s)) out.push(`${l.id}: cites ${s}, which is not a change`)
  }
  const active = lessons.filter(l => l.status === 'active').length
  if (active > MAX_ACTIVE) out.push(`${active} active lessons, at most ${MAX_ACTIVE}`)
  return out
}
