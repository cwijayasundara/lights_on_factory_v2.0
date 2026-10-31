// The {{name}} rules as plain functions: no I/O, no framework, and nothing imported from another layer.
export class {{Name}}Error extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function create{{Name}}({ id, name }) {
  if (typeof id !== 'string' || !id.trim()) throw new {{Name}}Error('invalid-id', 'id is required')
  if (typeof name !== 'string' || !name.trim()) throw new {{Name}}Error('invalid-name', 'name is required')
  return { id: id.trim(), name: name.trim() }
}
