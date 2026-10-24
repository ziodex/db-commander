import { _electron as electron, expect } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertDesktopReady } from './desktop-readiness.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = join(root, 'docs/screenshots')
const profile = await mkdtemp(join(tmpdir(), 'dbcommander-screenshots-'))
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const env = { ...process.env, SQLCOMMANDER_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE
let app

const demo = `CREATE TABLE customers (
  customer_id INTEGER PRIMARY KEY, name VARCHAR NOT NULL,
  city VARCHAR NOT NULL, country VARCHAR NOT NULL
);
INSERT INTO customers VALUES
  (1, 'Avery Chen', 'Oslo', 'Norway'),
  (2, 'Nora Ellis', 'Copenhagen', 'Denmark'),
  (3, 'Theo Morgan', 'Stockholm', 'Sweden'),
  (4, 'Maya Quinn', 'Helsinki', 'Finland'),
  (5, 'Eli Rivera', 'Amsterdam', 'Netherlands'),
  (6, 'Lena Reed', 'Berlin', 'Germany'),
  (7, 'Noah Brooks', 'Paris', 'France'),
  (8, 'Iris Shaw', 'Madrid', 'Spain');
CREATE TABLE products (
  product_id INTEGER PRIMARY KEY, product_name VARCHAR NOT NULL,
  category VARCHAR NOT NULL, unit_price DECIMAL(10,2) NOT NULL
);
INSERT INTO products VALUES
  (1, 'Studio keyboard', 'Workspace', 129.00),
  (2, 'Monitor stand', 'Workspace', 89.00),
  (3, 'Task lamp', 'Lighting', 75.00),
  (4, 'Reading light', 'Lighting', 49.00),
  (5, 'Daily notebook', 'Stationery', 18.00),
  (6, 'Sketchbook', 'Stationery', 24.00),
  (7, 'Desk speakers', 'Audio', 149.00),
  (8, 'Studio headphones', 'Audio', 199.00);
CREATE TABLE orders (
  order_id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  ordered_at DATE NOT NULL, status VARCHAR NOT NULL
);
INSERT INTO orders
SELECT id, 1 + id % 8, DATE '2026-01-01' + (id * 3)::INTEGER,
  CASE WHEN id % 7 = 0 THEN 'pending' ELSE 'completed' END
FROM range(1, 73) AS sample(id);
CREATE TABLE order_items (
  order_id INTEGER REFERENCES orders(order_id),
  product_id INTEGER REFERENCES products(product_id),
  quantity INTEGER NOT NULL, unit_price DECIMAL(10,2) NOT NULL,
  PRIMARY KEY (order_id, product_id)
);
INSERT INTO order_items
SELECT o.order_id, p.product_id, 1 + o.order_id % 3, p.unit_price
FROM orders o CROSS JOIN range(2) AS item(position)
JOIN products p ON p.product_id = 1 + (o.order_id + item.position) % 8;
CREATE VIEW monthly_sales AS
SELECT date_trunc('month', o.ordered_at) AS month,
  SUM(i.quantity * i.unit_price) AS revenue
FROM orders o JOIN order_items i USING (order_id)
WHERE o.status = 'completed' GROUP BY 1;`

const query = `-- Revenue by market · demo data, January–August 2026
SELECT
    c.country AS market,
    COUNT(DISTINCT o.order_id) AS orders,
    SUM(i.quantity) AS items,
    SUM(i.quantity * i.unit_price) AS revenue
FROM orders AS o
JOIN customers AS c ON c.customer_id = o.customer_id
JOIN order_items AS i ON i.order_id = o.order_id
WHERE o.status = 'completed'
GROUP BY c.country
ORDER BY revenue DESC;`

const productQuery = `-- Product catalog · demo data
SELECT
    product_id,
    product_name,
    category,
    unit_price
FROM products
ORDER BY product_id;`

try {
  assertDesktopReady()
  await mkdir(output, { recursive: true })
  app = await electron.launch({ args: [root], cwd: root, env })
  const page = await app.firstWindow()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 960))
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 1440, height: 960 })
  async function appearance(theme) {
    await page.getByRole('button', { name: 'Application preferences', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Preferences', exact: true })
    await settings.getByLabel('Appearance', { exact: true }).selectOption(theme)
    await settings.getByRole('button', { name: 'Apply settings', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  }
  async function run(sql) {
    await expect(page.getByRole('button', { name: /^Run SQL/ })).toBeEnabled()
    await page.locator('.monaco-editor').first().click()
    await page.keyboard.press(`${modifier}+A`)
    // Paste as one editor operation without changing the system clipboard.
    await page.locator('.monaco-editor textarea.inputarea').first().evaluate((input, text) => {
      const data = new DataTransfer()
      data.setData('text/plain', text)
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, sql)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^Run SQL/ }).click()
    await expect(page.locator('.status-text')).toHaveText(/^(Completed|Failed)$/, { timeout: 30_000 })
    if (await page.locator('.status-text').innerText() === 'Failed') throw new Error(`Demo SQL failed: ${(await page.locator('body').innerText()).slice(-3000)}`)
  }
  async function capture(name) {
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
    await page.mouse.move(1435, 955)
    await page.screenshot({ path: join(output, name), scale: 'css', animations: 'disabled' })
  }
  await appearance('dark')
  await page.getByRole('button', { name: 'Connect database', exact: true }).click()
  const connection = page.getByRole('dialog')
  await connection.getByLabel('Database engine').selectOption('duckdb')
  await connection.getByLabel('Connection name', { exact: true }).fill('Studio shop · demo')
  await connection.getByLabel('Open mode').selectOption('memory')
  await connection.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(connection).not.toBeVisible()
  await run(demo)
  await page.getByRole('button', { name: 'Refresh schema', exact: true }).click()
  await expect(page.locator('.schema-object > button').filter({ has: page.getByText('customers', { exact: true }) })).toBeVisible()
  await run(query)
  await expect(page.getByRole('cell', { name: 'Norway', exact: true })).toBeVisible()
  const splitter = page.getByRole('separator', { name: 'Resize results', exact: true })
  await splitter.focus()
  for (let step = 0; step < 3; step++) await page.keyboard.press('Shift+ArrowUp')
  await expect.poll(() => page.locator('.results-region').evaluate(element => element.getBoundingClientRect().height)).toBe(470)
  await page.locator('.monaco-editor').first().click({ position: { x: 180, y: 60 } })
  await expect(page.getByRole('row').last()).toBeInViewport({ ratio: 1 })
  await page.locator('[data-result-row="0"][data-result-column="0"]').click()
  await page.locator('[data-result-row="2"][data-result-column="3"]').click({ modifiers: ['Shift'] })
  await expect(page.locator('[data-selected=true]')).toHaveCount(12)
  await capture('query-workbench-dark.png')

  await appearance('light')
  await run(productQuery)
  await splitter.focus()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await page.locator('.monaco-editor').first().click({ position: { x: 180, y: 60 } })
  const products = page.locator('.schema-object > button').filter({ has: page.getByText('products', { exact: true }) })
  await products.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Browse data products', exact: true }).click()
  await expect(page.getByRole('table', { name: 'Table data', exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Studio keyboard', exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Studio headphones', exact: true })).toBeInViewport({ ratio: 1 })
  await capture('table-browser-light.png')

  await page.locator('.database-node.current > button').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'ER diagram', exact: true }).click()
  const diagram = page.getByRole('dialog', { name: 'ER diagram', exact: true })
  await expect(diagram.locator('p[role=status]')).toHaveText('Diagram refreshed.', { timeout: 30_000 })
  await expect(diagram.getByRole('img', { name: 'Entity relationship diagram' })).toBeVisible()
  await diagram.getByRole('button', { name: 'Fit diagram', exact: true }).click()
  await capture('schema-diagram-light.png')

  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  await writeFile(join(output, 'capture.json'), JSON.stringify({
    appVersion: metadata.version,
    appSourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    capturedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    viewport: { width: 1440, height: 960 },
    data: 'Synthetic in-memory DuckDB shop, created by scripts/capture-screenshots.mjs',
    files: ['query-workbench-dark.png', 'table-browser-light.png', 'schema-diagram-light.png']
  }, null, 2) + '\n')
  console.log(`Captured three app screenshots in ${output}`)
} finally {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {})
  await app?.close().catch(() => {})
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
