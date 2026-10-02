#!/usr/bin/env node
/**
 * 用 GitHub REST API 把博客推送到 GitHub Pages —— 不需要安装 git。
 *
 * 用法：
 *   node deploy-github.mjs                  # 从同目录 github-token.txt 读令牌
 *   node deploy-github.mjs <PAT>            # 或直接传令牌
 *   node deploy-github.mjs <PAT> <仓库名>   # 默认仓库名 = <用户名>.github.io
 *
 * 令牌需要 classic PAT，勾选 repo + workflow 两个 scope。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OWNER = 'Mango884877777777';
const API = 'https://api.github.com';
const BRANCH = 'main';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.astro', '.git', '.vercel']);
const CONCURRENCY = 8;

// ---------- 取令牌 ----------
let token = process.argv[2];
if (!token) {
  const tokenFile = path.join(__dirname, 'github-token.txt');
  if (fs.existsSync(tokenFile)) {
    const raw = fs.readFileSync(tokenFile, 'utf8');
    // 从文件里直接认出令牌本体，这样即使占位说明那行没删掉也不影响
    const m = raw.match(/\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,})\b/);
    token = m ? m[1] : raw.trim();
  }
}
if (!token || !/^(ghp_|github_pat_|gho_|ghs_)/.test(token)) {
  console.error('✗ 没有找到有效的 GitHub 访问令牌。');
  console.error('  预期在文件里看到 ghp_ 或 github_pat_ 开头的字符串：');
  console.error('  ' + path.join(__dirname, 'github-token.txt'));
  console.error('  当前读到的是: ' + (token ? JSON.stringify(token.slice(0, 40)) : '(空)'));
  process.exit(1);
}
token = token.replace(/^["'\s]+|["'\s]+$/g, '');
const REPO = (process.argv[3] || `${OWNER}.github.io`).trim();

const log = (m) => console.log(m);
const warn = (m) => console.warn('  ! ' + m);

async function api(method, url, body, okCodes = [200, 201]) {
  const res = await fetch(url.startsWith('http') ? url : API + url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-blog-deployer',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (!okCodes.includes(res.status)) {
    const msg = json && json.message ? json.message : text.slice(0, 300);
    const err = new Error(`HTTP ${res.status} ${method} ${url} -> ${msg}`);
    err.status = res.status;
    err.json = json;
    throw err;
  }
  return { status: res.status, json };
}

// ---------- 1. 校验令牌 ----------
log('=== 1/6 校验访问令牌 ===');
const me = await api('GET', '/user');
log(`  ✓ 已认证为 ${me.json.login}` + (me.json.login.toLowerCase() === OWNER.toLowerCase() ? '' : `  (注意:与目标账号 ${OWNER} 不同)`));

// ---------- 2. 创建仓库 ----------
log(`\n=== 2/6 创建/确认仓库 ${OWNER}/${REPO} ===`);
try {
  await api('GET', `/repos/${OWNER}/${REPO}`).catch((e) => { throw e; });
  log('  · 仓库已存在，直接推送');
} catch (e) {
  if (e.status === 404) {
    try {
      await api('POST', '/user/repos', {
        name: REPO,
        description: '芒果干的太阳浴场 —— 个人博客（Astro + Fuwari）',
        homepage: `https://${OWNER.toLowerCase()}.github.io/`,
        private: false,
        has_issues: true,
        has_wiki: false,
        auto_init: false,
      });
      log('  ✓ 仓库已创建（空仓库）');
    } catch (e2) {
      if (e2.status === 422) log('  · 仓库已存在，直接推送');
      else throw e2;
    }
  } else throw e;
}

// ---------- 3. 收集文件 ----------
log('\n=== 3/6 收集要上传的文件 ===');
function walk(dir, base = '') {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      out.push(...walk(path.join(dir, ent.name), path.posix.join(base, ent.name)));
    } else if (ent.isFile()) {
      // 令牌文件绝不能上传
      if (ent.name === 'github-token.txt') continue;
      out.push({ abs: path.join(dir, ent.name), rel: path.posix.join(base, ent.name) });
    }
  }
  return out;
}
const files = walk(PROJECT_DIR);
log(`  ✓ 共 ${files.length} 个文件，${(files.reduce((s, f) => s + fs.statSync(f.abs).size, 0) / 1048576).toFixed(2)} MB`);
if (files.length === 0) { console.error('✗ 没找到文件'); process.exit(1); }

// ---------- 3.5 确保仓库已有初始提交 ----------
// 空的 Git 仓库没有对象库，直接建 blob 会返回 409 "Git Repository is empty"。
// 所以先用 Contents API 落一个文件，让仓库产生第一次提交。
log('\n=== 3.5/6 确保仓库有初始提交 ===');
const repoInfo = await api('GET', `/repos/${OWNER}/${REPO}`);
const branch = repoInfo.json.default_branch || BRANCH;
let parent = null;
try {
  const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${branch}`);
  parent = ref.json.object.sha;
  log(`  · 分支 ${branch} 已存在（${parent.slice(0, 10)}），按追加提交处理`);
} catch (e) {
  // 空仓库时 GitHub 返回 409 "Git Repository is empty"；分支不存在时返回 404。两种都算「还没有提交」
  if (e.status === 404 || e.status === 409) {
    log('  · 仓库还是空的，先建立一个初始提交…');
    await api('PUT', `/repos/${OWNER}/${REPO}/contents/.deploy-bootstrap`, {
      message: 'chore: 初始化仓库',
      content: Buffer.from('bootstrap\n').toString('base64'),
      branch,
    }, [201]);
    const ref2 = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${branch}`);
    parent = ref2.json.object.sha;
    log(`  ✓ 初始提交已建立（${parent.slice(0, 10)}）`);
  } else {
    warn('读取分支失败，按首次推送处理：' + e.message);
  }
}

// ---------- 4. 上传 blobs ----------
log('\n=== 4/6 上传文件内容（生成 blob）===');
const blobs = new Array(files.length);
let done = 0;
async function worker(startIdx) {
  for (let i = startIdx; i < files.length; i += CONCURRENCY) {
    const f = files[i];
    const content = fs.readFileSync(f.abs).toString('base64');
    const r = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, { content, encoding: 'base64' });
    blobs[i] = { path: f.rel, mode: '100644', type: 'blob', sha: r.json.sha };
    done++;
    if (done % 25 === 0 || done === files.length) log(`  ${done}/${files.length}`);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, (_, k) => worker(k)));
log('  ✓ 全部上传完成');

// ---------- 5. 建 tree / commit / ref ----------
log('\n=== 5/6 创建提交并推送 ===');
const tree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, { tree: blobs });
log(`  ✓ tree ${tree.json.sha.slice(0, 10)}`);

const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
  message: '初始化：芒果干的太阳浴场（Astro + Fuwari）',
  tree: tree.json.sha,
  parents: parent ? [parent] : [],
});
log(`  ✓ commit ${commit.json.sha.slice(0, 10)}`);

await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${branch}`, { sha: commit.json.sha, force: true });
log(`  ✓ 已推送到 ${branch}`);

// ---------- 6. 开启 Pages ----------
log('\n=== 6/6 开启 GitHub Pages（Actions 构建）===');
try {
  await api('POST', `/repos/${OWNER}/${REPO}/pages`, { build_type: 'workflow' }, [201, 204, 409]);
  log('  ✓ Pages 已启用，构建来源 = GitHub Actions');
} catch (e) {
  if (e.status === 409) log('  · Pages 已经是启用状态');
  else {
    warn('自动开启 Pages 失败：' + e.message);
    warn('请手动操作：仓库 Settings → Pages → Build and deployment → Source 选「GitHub Actions」');
  }
}

log('\n' + '='.repeat(56));
log('  完成！');
log(`  仓库   : https://github.com/${OWNER}/${REPO}`);
log(`  网站   : https://${OWNER.toLowerCase()}.github.io/`);
log('  首次部署约需 1~3 分钟，可在仓库的 Actions 标签页看进度。');
log('='.repeat(56));
