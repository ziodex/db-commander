// Render the Db Commander database-and-command brand with Electron's pinned SVG rasterizer.
// No external graphics tools or network downloads are needed on any platform.
const { app, BrowserWindow, nativeImage } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { resolve, join } = require('node:path')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-device-scale-factor', '1')
const root = resolve(__dirname, '../build/icons')
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1024, height: 1024, frame: false, show: false, transparent: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } })
  try {
    await window.loadURL('data:text/html,<meta charset="utf-8">')
    // Canvas rasterization does not depend on a visible compositor surface.
    const render = async name => nativeImage.createFromDataURL(await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const image = new Image(); image.onerror = () => reject(new Error('Cannot render SVG'));
        image.onload = () => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
          canvas.getContext('2d').drawImage(image, 0, 0, 1024, 1024); resolve(canvas.toDataURL('image/png'));
        };
        image.src = ${JSON.stringify('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(readFileSync(join(root, name), 'utf8')))};
      })`))
    const image = await render('icon.svg')
    if (image.getSize().width !== 1024 || image.getSize().height !== 1024) throw new Error('The icon renderer did not produce a 1024px master.')
    const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
    const pngs = new Map(sizes.map(size => [size, image.resize({ width: size, height: size, quality: 'best' }).toPNG()]))
    for (const [size, png] of pngs) writeFileSync(join(root, `${size}x${size}.png`), png)
    // Modern Windows ICO entries may contain PNGs, including the 256px image.
    const icoSizes = sizes.filter(size => size <= 256), entries = Buffer.alloc(6 + icoSizes.length * 16)
    entries.writeUInt16LE(1, 2); entries.writeUInt16LE(icoSizes.length, 4)
    let offset = entries.length
    icoSizes.forEach((size, index) => {
      const start = 6 + index * 16, png = pngs.get(size)
      entries[start] = entries[start + 1] = size === 256 ? 0 : size
      entries.writeUInt16LE(1, start + 4); entries.writeUInt16LE(32, start + 6)
      entries.writeUInt32LE(png.length, start + 8); entries.writeUInt32LE(offset, start + 12); offset += png.length
    })
    writeFileSync(join(root, 'icon.ico'), Buffer.concat([entries, ...icoSizes.map(size => pngs.get(size))]))
    // ICNS supports these PNG-backed size entries on all supported macOS versions.
    const chunks = [[16, 'icp4'], [32, 'icp5'], [64, 'icp6'], [128, 'ic07'], [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']].map(([size, type]) => {
      const png = pngs.get(size), header = Buffer.alloc(8); header.write(type); header.writeUInt32BE(8 + png.length, 4)
      return Buffer.concat([header, png])
    })
    const header = Buffer.alloc(8); header.write('icns'); header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4)
    writeFileSync(join(root, 'icon.icns'), Buffer.concat([header, ...chunks]))
    const tray = await render('tray.svg')
    for (const [size, name] of [[18, 'trayTemplate.png'], [36, 'trayTemplate@2x.png']]) {
      writeFileSync(join(root, name), tray.resize({ width: size, height: size, quality: 'best' }).toPNG())
    }
    console.log('Generated Db Commander PNG, Windows ICO, macOS ICNS and tray assets.')
  } finally { window.destroy() }
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
