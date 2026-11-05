interface DropStep {
  key: string
  name: string
  requiredDrops?: { key: string; name: string }[]
}

/** Order dependent table drops before the referenced tables. Each selected
 * parent carries its visible incoming references, including out-of-scope ones. */
export function orderMigrationDrops<T extends DropStep>(selected: T[]): T[] {
  const drops = new Map(selected.map(item => [item.key, item]))
  const ordered: T[] = []
  const visiting = new Set<string>(), visited = new Set<string>()
  function visit(item: T) {
    if (visited.has(item.key)) return
    if (visiting.has(item.key)) throw new Error('Selected table drops contain a foreign-key cycle. Review and remove the relevant constraints manually.')
    visiting.add(item.key)
    for (const reference of item.requiredDrops ?? []) {
      const child = drops.get(reference.key)
      if (!child) throw new Error(`Cannot include the drop of ${item.name}. The target table ${reference.name} still references it.`)
      visit(child)
    }
    visiting.delete(item.key)
    visited.add(item.key)
    ordered.push(item)
  }
  for (const item of selected) visit(item)
  return ordered
}
