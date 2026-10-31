// The edge: a request becomes a use case call, and a domain error becomes a status. It imports the use cases and the domain, never the store.
import { {{Name}}Error } from '../domain/{{name}}.js'

const STATUS = { 'not-found': 404 }

export function make{{Name}}Handler(service) {
  return function handle({ method, path, body = {} }) {
    try {
      if (method === 'POST' && path === '/{{name}}s') return { status: 201, body: service.add(body) }
      if (method === 'GET' && path.startsWith('/{{name}}s/')) return { status: 200, body: service.get(decodeURIComponent(path.slice('/{{name}}s/'.length))) }
      return { status: 404, body: { error: 'not found' } }
    } catch (err) {
      if (err instanceof {{Name}}Error) return { status: STATUS[err.code] ?? 400, body: { error: err.message, code: err.code } }
      throw err
    }
  }
}
