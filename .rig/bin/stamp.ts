// The tree stamp: one fingerprint of everything a verdict depends on, so a later gate can ask "is this the tree that was
// verified?" instead of running the same commands again. Local evidence only: CI never reads a stamp.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ROOT, SENSORS_PATH, SDLC, git, read, sha } from './core.ts'

// What `git write-tree` would record for the working tree (tracked and untracked files, ignored ones left out) with
// .rig/ removed: harness evidence changes with every run, and the same content has the same stamp before and after a
// commit. The two config files are folded in separately because they sit inside .rig/. Null when there is no commit.
export function treeStamp(): string | null {
  if (!git(['rev-parse', '--verify', '--quiet', 'HEAD'])) return null
  const index = git(['rev-parse', '--path-format=absolute', '--git-path', 'index'])
  if (!index) return null
  const tmp = path.join(os.tmpdir(), `rig-index-${process.pid}-${Math.random().toString(36).slice(2)}`)
  try {
    if (fs.existsSync(index)) {
      fs.copyFileSync(index, tmp)
      // Keep the real index's mtime: git decides whether a same-second, same-size edit is "racily clean" by comparing entry
      // times with the index file's time, and a fresh copy would make a stale cached blob look trustworthy.
      const st = fs.statSync(index)
      fs.utimesSync(tmp, st.atime, st.mtime)
    }
    const run = (args: string[]): string => execFileSync('git', args, { cwd: ROOT, env: { ...process.env, GIT_INDEX_FILE: tmp }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }).trim()
    run(['add', '-A', '--', '.', ':(exclude).rig'])
    run(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '.rig'])
    return sha([run(['write-tree']), sha(read(SENSORS_PATH)), sha(read(path.join(SDLC, 'rules.json')))].join('|'))
  } catch {
    return null
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}
