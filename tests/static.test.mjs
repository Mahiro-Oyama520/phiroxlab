import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function read(relative) {
  return readFile(path.join(ROOT, relative), 'utf8');
}

test('HTML ids are unique and every id referenced by app.js exists', async () => {
  const html = await read('index.html');
  const app = await read('js/app.js');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, 'duplicate HTML ids found');

  const referenced = [...app.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]);
  const direct = [...app.matchAll(/document\.getElementById\('([^']+)'\)/g)].map((match) => match[1]);
  for (const id of new Set([...referenced, ...direct])) {
    assert.ok(unique.has(id), `app.js references missing id #${id}`);
  }
});

test('manifest is valid JSON and all icons exist', async () => {
  const manifest = JSON.parse(await read('manifest.webmanifest'));
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.ok(manifest.icons.length >= 2);
  for (const icon of manifest.icons) {
    const file = icon.src.replace(/^\.\//, '');
    const info = await stat(path.join(ROOT, file));
    assert.ok(info.isFile(), `missing icon ${file}`);
    assert.ok(info.size > 1000, `suspiciously small icon ${file}`);
  }
});

test('service worker pre-cache paths all exist', async () => {
  const sw = await read('sw.js');
  const list = sw.match(/const APP_SHELL = \[(.*?)\];/s);
  assert.ok(list, 'APP_SHELL missing');
  const paths = [...list[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.ok(paths.length >= 8);
  for (const item of paths) {
    if (item === './') continue;
    const info = await stat(path.join(ROOT, item.replace(/^\.\//, '')));
    assert.ok(info.isFile(), `missing precached asset ${item}`);
  }
});

test('index references the required app assets', async () => {
  const html = await read('index.html');
  for (const reference of ['./app.css', './js/app.js', './manifest.webmanifest', './assets/icon-192.png']) {
    assert.ok(html.includes(reference), `index.html is missing ${reference}`);
  }
  assert.ok(html.includes('name="viewport"'));
  assert.ok(html.includes('Web Bluetooth') || html.includes('蓝牙'));
  assert.ok(html.includes('非官方'));
});

test('no inline script is used under the CSP', async () => {
  const html = await read('index.html');
  assert.ok(!/<script(?![^>]*src=)[^>]*>/i.test(html), 'inline scripts would be blocked by CSP');
});

test('PWA source files contain no accidental local absolute paths', async () => {
  for (const file of ['index.html', 'app.css', 'sw.js', 'js/app.js', 'js/ble.js']) {
    const source = await read(file);
    assert.ok(!/C:\\Users\\|file:\/\//i.test(source), `${file} contains a local path`);
  }
});
