// PLAN.md parsing and the lock rule. Plain ESM, no dependencies.

const TASK = /^- \[( |x|!)\] (\d+)\. (.+)$/
const FIELD = /^ {2}(verify|after|done|blocked): (.+)$/
const STATUS = { ' ': 'open', x: 'done', '!': 'blocked' }

export function parsePlan(text) {
  const tasks = []
  const errors = []
  let current = null
  text.split('\n').forEach((raw, index) => {
    const line = index + 1
    const content = raw.trimEnd()
    const task = TASK.exec(content)
    if (task) {
      current = { n: Number(task[2]), status: STATUS[task[1]], outcome: task[3].trim(), verify: '', after: [], line }
      tasks.push(current)
      return
    }
    const field = FIELD.exec(content)
    if (field && current) {
      addField(current, field[1], field[2].trim(), line, errors)
      return
    }
    if (current && content !== '') errors.push({ line, message: `unrecognised line in task ${current.n}: "${content.trim()}"` })
  })
  errors.push(...validate(tasks))
  errors.sort((a, b) => a.line - b.line)
  return errors.length ? { ok: false, errors } : { ok: true, tasks }
}

function addField(task, key, value, line, errors) {
  if (key !== 'after') {
    task[key] = value
    return
  }
  const parts = value.split(',').map(part => part.trim())
  if (parts.some(part => !/^\d+$/.test(part))) {
    errors.push({ line, message: `task ${task.n} has an after: that is not a list of task numbers` })
    return
  }
  task.after = parts.map(Number)
}

function validate(tasks) {
  const errors = []
  const byNumber = new Map()
  for (const task of tasks) {
    if (byNumber.has(task.n)) errors.push({ line: task.line, message: `task ${task.n} is numbered twice` })
    byNumber.set(task.n, task)
    if (!task.verify) errors.push({ line: task.line, message: `task ${task.n} has no verify: line` })
    if (task.status === 'done' && !task.done) errors.push({ line: task.line, message: `task ${task.n} is done but has no done: commit` })
    if (task.status === 'blocked' && !task.blocked) {
      errors.push({ line: task.line, message: `task ${task.n} is blocked but has no blocked: pointer` })
    }
  }
  for (const task of tasks) {
    for (const dep of task.after) {
      if (!byNumber.has(dep)) errors.push({ line: task.line, message: `task ${task.n} depends on task ${dep}, which does not exist` })
    }
  }
  const cycle = findCycle(tasks, byNumber)
  if (cycle) errors.push({ line: byNumber.get(cycle[0]).line, message: `dependency cycle: ${cycle.map(n => `task ${n}`).join(' -> ')}` })
  return errors
}

function findCycle(tasks, byNumber) {
  const state = new Map()
  const walk = (n, path) => {
    if (state.get(n) === 'done') return null
    if (state.get(n) === 'active') return [...path.slice(path.indexOf(n)), n]
    state.set(n, 'active')
    for (const dep of byNumber.get(n)?.after ?? []) {
      if (!byNumber.has(dep)) continue
      const found = walk(dep, [...path, n])
      if (found) return found
    }
    state.set(n, 'done')
    return null
  }
  for (const task of tasks) {
    const found = walk(task.n, [])
    if (found) return found
  }
  return null
}

export function checkLock(baseline, current) {
  const now = new Map(current.map(task => [task.n, task]))
  const problems = []
  for (const before of baseline) {
    const after = now.get(before.n)
    if (!after) {
      problems.push(`task ${before.n} was removed`)
      continue
    }
    if (after.outcome !== before.outcome) problems.push(`task ${before.n} outcome changed`)
    if (after.verify !== before.verify) problems.push(`task ${before.n} verify: changed`)
    const lost = before.after.filter(dep => !after.after.includes(dep))
    if (lost.length) problems.push(`task ${before.n} after: lost ${lost.join(', ')}`)
  }
  return problems.length ? { ok: false, problems } : { ok: true }
}

// Open tasks that depend, directly or through other tasks, on a blocked task.
export function skippedTasks(tasks) {
  const byNumber = new Map(tasks.map(task => [task.n, task]))
  const memo = new Map()
  const reachesBlocked = task => {
    if (memo.has(task.n)) return memo.get(task.n)
    memo.set(task.n, false)
    const result = task.after.some(dep => {
      const parent = byNumber.get(dep)
      return parent && (parent.status === 'blocked' || reachesBlocked(parent))
    })
    memo.set(task.n, result)
    return result
  }
  return tasks.filter(task => task.status === 'open' && reachesBlocked(task))
}

export function nextTask(tasks) {
  const byNumber = new Map(tasks.map(task => [task.n, task]))
  const skipped = new Set(skippedTasks(tasks).map(task => task.n))
  const ready = tasks
    .filter(task => task.status === 'open' && !skipped.has(task.n))
    .filter(task => task.after.every(dep => byNumber.get(dep)?.status === 'done'))
    .sort((a, b) => a.n - b.n)
  return ready[0] ?? null
}
