'use strict';
// Installs a pinned npm package tarball on the device: download from the registry,
// check the Subresource-Integrity hash from pins.json, then unpack the files the
// filter accepts. Nothing third-party is shipped inside the app binary; the user's
// device fetches it from the publisher's registry.

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const zlib = require('zlib');

function download(url, { onProgress = () => {}, redirects = 5, fetchImpl } = {}) {
  if (fetchImpl) return fetchImpl(url);
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'TermForge-installer', accept: 'application/octet-stream' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error(`too many redirects fetching ${url}`));
        return resolve(download(new URL(res.headers.location, url).href, { onProgress, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
      }
      const total = Number(res.headers['content-length']) || 0;
      const parts = [];
      let got = 0;
      res.on('data', (c) => {
        parts.push(c);
        got += c.length;
        onProgress(got, total);
      });
      res.on('end', () => resolve(Buffer.concat(parts, got)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error(`timeout fetching ${url}`)));
  });
}

// integrity: "sha512-<base64>" (npm's dist.integrity, SRI format)
function verifyIntegrity(buf, integrity) {
  const m = /^(sha256|sha384|sha512)-([A-Za-z0-9+/=]+)$/.exec(String(integrity || '').trim());
  if (!m) throw new Error(`unsupported integrity string: ${integrity}`);
  const actual = crypto.createHash(m[1]).update(buf).digest('base64');
  if (actual !== m[2]) throw new Error(`integrity mismatch: expected ${m[1]}-${m[2]}, got ${m[1]}-${actual}`);
}

function octal(buf, off, len) {
  const s = buf.toString('ascii', off, off + len).replace(/\0.*$/, '').trim();
  return s ? parseInt(s, 8) : 0;
}

function cstr(buf, off, len) {
  const end = buf.indexOf(0, off);
  return buf.toString('utf8', off, end >= 0 && end < off + len ? end : off + len);
}

// Minimal ustar/pax/GNU reader for npm tarballs: yields { name, type, mode, data }.
function* untar(tar) {
  let off = 0;
  let paxPath = null;
  let longName = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 0x30);
    const mode = octal(h, 100, 8);
    const prefix = h.toString('ascii', 257, 262) === 'ustar' ? cstr(h, 345, 155) : '';
    let name = cstr(h, 0, 100);
    if (prefix) name = `${prefix}/${name}`;
    const data = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      for (const rec of data.toString('utf8').split('\n')) {
        const m = /^\d+ path=(.*)$/.exec(rec);
        if (m) paxPath = m[1];
      }
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      longName = cstr(data, 0, data.length);
      continue;
    }
    if (longName) name = longName;
    if (paxPath) name = paxPath;
    longName = null;
    paxPath = null;
    yield { name, type, mode, data };
  }
}

function safeJoin(root, rel) {
  const norm = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (norm.startsWith('../') || norm === '..' || path.posix.isAbsolute(norm)) throw new Error(`unsafe path in archive: ${rel}`);
  return path.join(root, ...norm.split('/'));
}

// Unpack into <destRoot>/<version>/ atomically; returns a report of what was written/skipped.
async function installTarball({ pin, destRoot, accept = () => true, onProgress = () => {}, fetchImpl }) {
  const started = Date.now();
  const tgz = await download(pin.tarball, { onProgress: (got, total) => onProgress({ phase: 'download', got, total }), fetchImpl });
  verifyIntegrity(tgz, pin.integrity);
  onProgress({ phase: 'verify', ok: true });
  const tar = zlib.gunzipSync(tgz);
  const finalDir = path.join(destRoot, pin.version);
  const staging = path.join(destRoot, `.staging-${pin.version}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(staging, { recursive: true });
  const written = [];
  const skipped = [];
  try {
    for (const entry of untar(tar)) {
      const rel = entry.name.replace(/^package\//, '');
      if (entry.type !== '0' && entry.type !== '\0' && entry.type !== '5') {
        skipped.push({ path: rel, reason: `tar entry type ${JSON.stringify(entry.type)}` });
        continue;
      }
      if (entry.type === '5') continue;
      const verdict = accept(rel, entry);
      if (verdict !== true) {
        skipped.push({ path: rel, reason: typeof verdict === 'string' ? verdict : 'filtered', bytes: entry.data.length });
        continue;
      }
      const out = safeJoin(staging, rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, entry.data, { mode: 0o644 });
      written.push({ path: rel, bytes: entry.data.length });
    }
    const manifest = {
      name: pin.name, version: pin.version, integrity: pin.integrity, tarball: pin.tarball,
      installedAt: new Date().toISOString(), ms: Date.now() - started, written, skipped,
    };
    fs.writeFileSync(path.join(staging, '.termforge-install.json'), JSON.stringify(manifest, null, 2));
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(staging, finalDir);
    onProgress({ phase: 'done', dir: finalDir });
    return { dir: finalDir, manifest };
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

function installedManifest(destRoot, version) {
  try {
    return JSON.parse(fs.readFileSync(path.join(destRoot, version, '.termforge-install.json'), 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { download, verifyIntegrity, untar, installTarball, installedManifest };
