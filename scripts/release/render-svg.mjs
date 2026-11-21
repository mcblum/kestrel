// Renders an SVG to a PNG of the given size with Electron's own Chromium, offscreen, on a
// transparent background. Used by make-icon.sh. Run as an Electron main script:
//   electron render-svg.mjs <in.svg> <out.png> <size>
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output, sizeArg] = process.argv.slice(-3);
const size = Number(sizeArg);
const RENDER_TIMEOUT_MS = 20_000;

if (!input || !output || !Number.isInteger(size) || size < 16) {
  console.error('usage: electron render-svg.mjs <in.svg> <out.png> <size>');
  process.exit(2);
}

app.dock?.hide();
app.disableHardwareAcceleration();
setTimeout(() => {
  console.error('render-svg: timed out');
  app.exit(1);
}, RENDER_TIMEOUT_MS).unref();

app.whenReady().then(async () => {
  const svg = readFileSync(input, 'utf8');
  const html = `<!doctype html><html><head><style>html,body{margin:0;background:transparent;overflow:hidden}img{display:block;width:${size}px;height:${size}px}</style></head><body><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`;
  const win = new BrowserWindow({ width: size, height: size, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true, deviceScaleFactor: 1 } });
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await win.webContents.executeJavaScript('document.images[0].decode().then(() => new Promise((r) => requestAnimationFrame(() => r())))');
  let image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  if (image.getSize().width !== size) image = image.resize({ width: size, height: size, quality: 'best' });
  writeFileSync(output, image.toPNG());
  app.exit(0);
}).catch((error) => {
  console.error(`render-svg: ${error?.message ?? error}`);
  app.exit(1);
});
