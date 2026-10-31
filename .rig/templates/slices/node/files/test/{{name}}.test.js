import { test } from 'node:test'
import assert from 'node:assert/strict'
import { make{{Name}}Service } from '../src/{{name}}/app/{{name}}-service.js'
import { makeMemoryStore } from '../src/{{name}}/infra/memory-store.js'
import { make{{Name}}Handler } from '../src/{{name}}/http/handler.js'

const handle = () => make{{Name}}Handler(make{{Name}}Service({ store: makeMemoryStore() }))

test('{{name}}: adds one and reads it back', () => {
  const h = handle()
  assert.equal(h({ method: 'POST', path: '/{{name}}s', body: { id: 'a1', name: ' First ' } }).status, 201)
  assert.deepEqual(h({ method: 'GET', path: '/{{name}}s/a1' }).body, { id: 'a1', name: 'First' })
})

test('{{name}}: a bad input is a 400 that carries a code', () => {
  const r = handle()({ method: 'POST', path: '/{{name}}s', body: { id: '', name: 'x' } })
  assert.deepEqual([r.status, r.body.code], [400, 'invalid-id'])
})

test('{{name}}: an unknown id is a 404', () => {
  assert.equal(handle()({ method: 'GET', path: '/{{name}}s/nope' }).status, 404)
})
