// The use cases: they combine the domain with a store they are given. They import the domain only; the store arrives as an argument.
import { create{{Name}}, {{Name}}Error } from '../domain/{{name}}.js'

export function make{{Name}}Service({ store }) {
  return {
    add(input) {
      const item = create{{Name}}(input)
      store.save(item)
      return item
    },
    get(id) {
      const item = store.get(id)
      if (!item) throw new {{Name}}Error('not-found', `no {{name}} ${id}`)
      return item
    },
  }
}
