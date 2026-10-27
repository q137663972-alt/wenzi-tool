#!/usr/bin/env node
// 文字工具 · 热更打包（纯 Node，零依赖）
// 功能：扫描 web/ 全部 H5 文件 → 算 build 指纹 → 打 code.<build>.zip
//      → 写 manifest.json / update.json → 双发到 hot/ 根 与 hot/pack/
//
// 规避小学学习乐园踩过的坑：
// ① build 指纹进 zip 文件名，新内容走全新 URL，绕开 jsDelivr 12h 缓存；
// ② zip 真实文件名写进 manifest.packs[].name（不写死 code.zip），否则设备 404；
// ③ 双发：hot/<name> 与 hot/pack/<name> 都放一份（老壳拉包 URL 不带 pack/ 前缀也接得住）；
// ④ 排除任何会被原生层读走的清单外内容；boot.js 此类冻结文件本项目不存在，安全。

import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// H5 版本标签：永远跟「已装 APK 版本」一致，绝不随 H5 内容升号（APK 版本纪律）
// APK 3.2.0 (versionCode 5) 引入真·强制更新原生桥
const APP_LABEL = '3.2.0';

const ROOT = dirname(fileURLToPath(import.meta.url)) + sep + '..';
const SRC = join(ROOT, 'web');
// 直接产出到 docs/：GitHub Pages 设为 main 分支 /docs 即可访问
const OUT = join(ROOT, 'docs');
const PACK_DIR = join(OUT, 'pack');

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// ---- 最小 zip 写入（store，无压缩；java.util.zip 可读取）----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = f.name.split(sep).join('/');
    const data = f.data;
    const crc = crc32(data);
    const nl = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);   // store
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nl.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, nl, data);
    const cs = Buffer.alloc(46);
    cs.writeUInt32LE(0x02014b50, 0);
    cs.writeUInt16LE(20, 4);
    cs.writeUInt16LE(20, 6);
    cs.writeUInt16LE(0, 8);
    cs.writeUInt16LE(0, 10);
    cs.writeUInt16LE(0, 12);
    cs.writeUInt16LE(0, 14);
    cs.writeUInt32LE(crc, 16);
    cs.writeUInt32LE(data.length, 20);
    cs.writeUInt32LE(data.length, 24);
    cs.writeUInt16LE(nl.length, 28);
    cs.writeUInt16LE(0, 30);
    cs.writeUInt16LE(0, 32);
    cs.writeUInt16LE(0, 34);
    cs.writeUInt16LE(0, 36);
    cs.writeUInt32LE(0, 38);
    cs.writeUInt32LE(offset, 42);
    central.push(cs, nl);
    offset += lh.length + nl.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...local, cd, eocd]);
}

// ---- 计算 build 指纹：所有文件内容 sha256 拼接后再 sha256 ----
const allFiles = walk(SRC).sort();
const concat = Buffer.concat(allFiles.map((p) => readFileSync(p)));
const build = createHash('sha256').update(concat).digest('hex').slice(0, 16);

const entries = allFiles.map((p) => ({
  name: relative(SRC, p),
  data: readFileSync(p),
}));
// 注入版本元数据：不参与 build 指纹（在指纹算完之后再写），避免循环依赖。
// H5 据此显示「当前 H5 版本(build)」；原生层也会把它随 zip 解压到 files/hot/version.json。
const versionMeta = JSON.stringify({ app: APP_LABEL, build, ts: new Date().toISOString() }, null, 2);
entries.push({ name: 'version.json', data: Buffer.from(versionMeta, 'utf8') });
const codeZip = zip(entries);
const codeName = `code.${build}.zip`;

if (existsSync(PACK_DIR)) rmSync(PACK_DIR, { recursive: true, force: true });
mkdirSync(PACK_DIR, { recursive: true });
writeFileSync(join(OUT, codeName), codeZip);          // hot/ 根（双发之一）
writeFileSync(join(PACK_DIR, codeName), codeZip);     // hot/pack/（双发之二）

const sha = createHash('sha256').update(codeZip).digest('hex');
const manifest = {
  build,
  packs: [{ name: codeName, sha256: sha, size: codeZip.length }],
};
writeFileSync(join(PACK_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

const update = {
  min_apk: 2,
  app: APP_LABEL,
  sig: 'local',
  build,
  ts: new Date().toISOString(),
  manifest: 'pack/manifest.json',
};
writeFileSync(join(OUT, 'update.json'), JSON.stringify(update, null, 2));

console.log(`build=${build}  zip=${codeName} (${codeZip.length} bytes) sha256=${sha}`);
console.log('已双发到 docs/ 根 与 docs/pack/');
