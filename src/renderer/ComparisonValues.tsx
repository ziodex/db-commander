import type { Cell } from '../shared/contracts'

export function ComparisonValues({ columns, left, right, labels, changed }: {
  columns: { name: string; type: string }[]
  left?: Cell[] | null
  right?: Cell[] | null
  labels: [string, string]
  changed: string[]
}) {
  const print = (value: Cell | undefined) => value === undefined ? 'Row absent' : JSON.stringify(value)
  return <div className="data-cell-table"><table>
    <thead><tr><th>Column</th><th>{labels[0]}</th><th>{labels[1]}</th></tr></thead>
    <tbody>{columns.map((column, index) => <tr key={column.name} className={changed.includes(column.name) ? 'changed' : ''}>
      <th scope="row">{column.name}<small>{column.type}</small></th>
      <td><pre>{print(left?.[index])}</pre></td><td><pre>{print(right?.[index])}</pre></td>
    </tr>)}</tbody>
  </table></div>
}
