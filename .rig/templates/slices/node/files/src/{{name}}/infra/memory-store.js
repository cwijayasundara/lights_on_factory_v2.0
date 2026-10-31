// A store the use cases can be given. Swap it for a database without touching the domain or the use cases.
export function makeMemoryStore() {
  const items = new Map()
  return {
    save(item) { items.set(item.id, item) },
    get(id) { return items.get(id) ?? null },
  }
}
