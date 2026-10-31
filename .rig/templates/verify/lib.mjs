// rig's journeys helper (optional): a driver in Node imports this to launch the app, walk its journeys and clean up.
// The contract a driver of ANY language meets is the same: exit 0 when every journey held and 1 when one did not, write evidence under
// $RIG_VERIFY_STATE/evidence.json as {"ok": true, "steps": [{"name": ..., "ok": true}, ...]} with at least one step (an exit 0 with no evidence
// counts as a failed run), and stop only the processes it started (never by name).
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const STATE = process.env.RIG_VERIFY_STATE ?? path.join(process.cwd(), '.rig/state/verify/app')
const started = new Set()
const sleep = ms => new Promise(r => setTimeout(r, ms))
// A process group on POSIX; on Windows the pid is the shell, so the whole tree goes (the app under it would outlive it and hold its pipes).
const kill = (pid, sig) => { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(-pid, sig) }

// Starts the app in its own process group, with PORT=0 so two runs never collide, and waits for a ready line whose first capture group is the port.
export async function launch(cmd, { cwd = process.cwd(), env = {}, ready = /listening on (\d+)/, timeoutMs = 30_000 } = {}) {
  const child = spawn(cmd, { cwd, shell: true, detached: process.platform !== 'win32', env: { ...process.env, PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  started.add(child)
  fs.mkdirSync(STATE, { recursive: true })
  fs.appendFileSync(path.join(STATE, 'pids'), `${child.pid}\n`)
  let log = ''
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the app printed no ready line within ${timeoutMs} ms; output so far: ${log.slice(-300)}`)), timeoutMs)
    const onData = d => { log += d; const m = ready.exec(log); if (m) { clearTimeout(timer); Number.isInteger(Number(m[1])) ? resolve(Number(m[1])) : reject(new Error('the ready pattern needs one capture group: the port')) } }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`the app exited with ${code} before it was ready: ${log.slice(-300)}`)) })
  })
  return { url: `http://127.0.0.1:${port}`, port, pid: child.pid }
}

// Kills only what this run started: each recorded process group, politely and then for good.
export async function stopAll() {
  for (const child of started) {
    for (const sig of ['SIGTERM', 'SIGKILL']) {
      try { kill(child.pid, sig) } catch { break }
      await sleep(sig === 'SIGTERM' ? 300 : 0)
    }
  }
  started.clear()
  fs.rmSync(path.join(STATE, 'pids'), { force: true })
}
process.on('exit', () => { for (const c of started) { try { kill(c.pid, 'SIGKILL') } catch { /* gone */ } } })

// verify('shop', async ({ launch, step }) => { ... }): the steps run in order; the first failed one stops the run, evidence is written either way.
export async function verify(app, fn) {
  const steps = []
  const step = async (name, run) => {
    const t0 = Date.now()
    try { const value = await run(); steps.push({ name, ok: true, ms: Date.now() - t0 }); return value } catch (e) { steps.push({ name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e) }); throw e }
  }
  let failure = null
  try { await fn({ launch, step }) } catch (e) { failure = e }
  await stopAll()
  fs.mkdirSync(STATE, { recursive: true })
  fs.writeFileSync(path.join(STATE, 'evidence.json'), JSON.stringify({ app, at: new Date().toISOString(), ok: !failure, steps }, null, 2) + '\n')
  for (const s of steps) console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.name}${s.ok ? '' : `: ${s.error}`}`)
  if (failure) process.exitCode = 1
}
