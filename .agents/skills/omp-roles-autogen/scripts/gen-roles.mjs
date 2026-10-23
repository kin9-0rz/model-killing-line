#!/usr/bin/env node
// gen-roles.mjs — 用「模型斩杀线」数据 + 本机 omp 模型目录，自动为 omp Chat 角色选模型，
// 生成 modelRoles / retry.fallbackChains / modelPresets 三块配置，默认写 ~/.omp/agent/config.yml。
//
// 数据来源（全部子进程 / 文件，不联网自抓）：
//   <dir>/aa-data.json          Artificial Analysis（fetch-aa.mjs，mtime ≥ 24h 时重抓）
//   <dir>/data.json             DeepSWE PASS@1（fetch.mjs，同上）
//   <dir>/omp-models.json       `omp models --json` 的缓存（缺失时才生成）
// fetch 脚本只认 MKL_DIR / --out，故用 `MKL_DIR=<dir>` 让输出落进 --dir；任一 fetch 失败直接退出，
// 不降级到旧数据（旧数据选出来的角色比报错更糟）。
//
// 选型规则见 SKILL.md「选型规则」，是固定规则（脚本定案），要改就改这里：
//   score = index - 40 * ln(1 + cost / 0.05)   （AA index 为主，成本对数惩罚）
//   同分：speed 降序 → DS pass 降序 → selector 字典序。
//   AA 名字 → 目录行：全等 → 唯一包含；同名多行按「models.yml 里配了的 provider → id 更短 →
//   smartbrain/ 前缀 → selector 更短 → 字典序」择一（内置 provider 没配 key 时调用必失败，
//   所以优先用户自己的 provider）。
//
// 用法: node gen-roles.mjs [--domestic] [--exclude <a,b>] [--min-speed <n>]
//                          [--preset <name>] [--dry-run] [--dir <dataDir>] [--out <modelsJson>]
import { readFileSync, writeFileSync, statSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSlug } from '../../model-killing-line/scripts/openrouter.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// 输出顺序沿用现有 config.yml 的角色顺序（memory 排在最后，最小化 diff 噪音）。
const ROLE_ORDER = ['default', 'vision', 'smol', 'slow', 'plan', 'commit', 'tiny', 'task', 'advisor', 'widget', 'memory'];
// AA Creator 列的国产集合（大小写不敏感；多列几个同义名，实际出现的是前 9 个）。
const DOMESTIC_CREATORS = new Set([
  'xiaomi', 'alibaba', 'deepseek', 'z ai', 'inclusionai', 'stepfun', 'kimi', 'minimax', 'tencent',
  'moonshot ai', 'zhipu', 'bytedance', '01.ai', 'iflytek', 'baichuan', 'sensetime', 'hunyuan', 'qwen',
]);
const SCORE_WEIGHT = 40;
const COST_FLOOR = 0.05;

const AGENT_DIR = process.env.OMP_AGENT_DIR ?? path.join(os.homedir(), '.omp', 'agent');
const CONFIG_PATH = path.join(AGENT_DIR, 'config.yml');
const MODELS_YML = path.join(AGENT_DIR, 'models.yml');

/** models.yml 里显式配置的 provider（有 baseUrl/apiKey）—— 只有它们保证真的能调通。
 *  内置 provider（如官方 `deepseek/`）也会出现在 `omp models --json` 里，但没配 key 时调用必失败，
 *  所以同名多行时优先用户自己配的 provider。 */
function readConfiguredProviders() {
  const names = new Set();
  let lines;
  try {
    lines = readFileSync(MODELS_YML, 'utf8').split(/\r?\n/);
  } catch {
    return names;
  }
  const at = lines.findIndex((l) => /^providers:\s*(#.*)?$/.test(l));
  if (at < 0) return names;
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) break; // 回到顶层键 → providers 块结束
    const m = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

const CONFIGURED_PROVIDERS = readConfiguredProviders();
const providerOf = (selector) => selector.split('/')[0];
/** creator 名归一化：大小写不敏感，连字符/下划线等同空格（`z-ai` 匹配 AA 的 `Z AI`） */
const normCreator = (s) => String(s).toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- CLI

const USAGE = `usage: node gen-roles.mjs [options]

  --domestic             只从国产 creator 里选
  --exclude <a,b,...>    排除 creator（大小写不敏感，可重复）
  --min-speed <tok/s>    AA 中位输出速度下限（默认 0 = 不过滤）
  --preset <name>        modelPresets 快照名（默认 autogen-YYYYMMDD）
  --dry-run              不写文件，只打印将替换/新增的块
  --dir <path>           榜单数据目录（默认 os.tmpdir()/model-killing-line）
  --out <path>           omp models --json 缓存（默认 <dir>/omp-models.json）
  -h, --help             打印本帮助`;

function parseArgs(argv) {
  const opts = {
    domestic: false,
    exclude: [],
    minSpeed: 0,
    preset: `autogen-${ymd()}`,
    dryRun: false,
    dir: process.env.MKL_DIR ?? path.join(os.tmpdir(), 'model-killing-line'),
    out: null,
  };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === '-h' || raw === '--help') {
      console.log(USAGE);
      process.exit(0);
    }
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : null;
    const take = () => {
      if (inline !== null) return inline;
      const v = argv[++i];
      if (v === undefined) fail(`${flag} needs a value`);
      return v;
    };
    if (seen.has(flag) && !['--exclude', '--dir', '--out'].includes(flag)) fail(`${flag} given twice`);
    seen.add(flag);
    switch (flag) {
      case '--domestic': opts.domestic = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--exclude':
        opts.exclude.push(...take().split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
        break;
      case '--min-speed': {
        const n = Number(take());
        if (!Number.isFinite(n) || n < 0) fail('--min-speed needs a non-negative number');
        opts.minSpeed = n;
        break;
      }
      case '--preset': {
        const v = take();
        if (!v) fail('--preset needs a name');
        opts.preset = v;
        break;
      }
      case '--dir': opts.dir = take(); break;
      case '--out': opts.out = take(); break;
      default:
        console.error(`unknown argument: ${raw}\n\n${USAGE}`);
        process.exit(1);
    }
  }
  return opts;
}

function fail(msg) {
  console.error(`gen-roles: ${msg}`);
  process.exit(1);
}

function ymd(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

// ---------------------------------------------------------------- 数据准备

function repoRoot() {
  let dir = HERE;
  for (;;) {
    if (existsSync(path.join(dir, '.agents', 'skills', 'model-killing-line', 'scripts', 'fetch-aa.mjs'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function ensureLeaderboardData(dataDir, dryRun) {
  const specs = [
    { file: 'aa-data.json', script: 'fetch-aa.mjs' },
    { file: 'data.json', script: 'fetch.mjs' },
  ];
  const stale = specs.filter(({ file }) => {
    const p = path.join(dataDir, file);
    if (!existsSync(p)) return true;
    return Date.now() - statSync(p).mtimeMs >= DATA_MAX_AGE_MS;
  });
  if (stale.length === 0) return;
  const root = repoRoot();
  if (!root) {
    fail(`missing/stale ${stale.map((s) => s.file).join(' + ')} in ${dataDir} and cannot locate ` +
      '.agents/skills/model-killing-line (needed to run its fetch scripts). ' +
      'Run the model-killing-line fetches yourself, or pass --dir with fresh data.');
  }
  for (const { file, script } of stale) {
    const scriptPath = path.join(root, '.agents', 'skills', 'model-killing-line', 'scripts', script);
    console.error(`gen-roles: refreshing ${file} via ${path.relative(root, scriptPath)}`);
    const r = spawnSync(process.execPath, [scriptPath], {
      env: { ...process.env, MKL_DIR: dataDir },
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      const detail = (r.stderr || r.stdout || r.error?.message || '').trim();
      fail(`${script} failed (exit ${r.status ?? 'n/a'})${detail ? `:\n${detail}` : ''}\n` +
        'fix model-killing-line\'s fetch script (page markup may have changed) — this skill never settles for stale data');
    }
    if (!dryRun) console.error((r.stdout ?? '').trim());
  }
}

function loadModels(modelsPath, dryRun) {
  if (existsSync(modelsPath)) {
    try {
      return normalizeModels(JSON.parse(readFileSync(modelsPath, 'utf8')));
    } catch (e) {
      fail(`cannot parse ${modelsPath}: ${e.message}\n` +
        `delete it (or pass --out) to regenerate via \`omp models --json\``);
    }
  }
  const attempts = process.platform === 'win32' ? ['omp', 'omp.cmd'] : ['omp'];
  let lastErr = '';
  for (const bin of attempts) {
    const r = spawnSync(bin, ['models', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0 && (r.stdout ?? '').trim()) {
      if (!dryRun) {
        mkdirSync(path.dirname(modelsPath), { recursive: true });
        writeFileSync(modelsPath, r.stdout);
      }
      return normalizeModels(JSON.parse(r.stdout));
    }
    lastErr = r.error?.message || (r.stderr ?? '').trim() || `exit ${r.status}`;
  }
  fail(`cannot run \`omp models --json\` (${lastErr}).\n` +
    `Generate it manually and re-run:\n  omp models --json > ${modelsPath}`);
}

function normalizeModels(parsed) {
  const list = Array.isArray(parsed) ? parsed : parsed?.models;
  if (!Array.isArray(list)) fail('omp models --json: expected an array or { models: [...] }');
  return list.filter((m) => m && m.selector && (m.kind ?? 'chat') === 'chat');
}

// ---------------------------------------------------------------- 候选池

/** 去尾部 effort 括号段（` (max)` / ` (0902)`）和日期串（` 1017`） */
function baseName(name) {
  let s = String(name).trim();
  s = s.replace(/(?:\s*\([^)]*\))+\s*$/g, '').trim();
  s = s.replace(/\s+\d{3,4}$/g, '').trim();
  return s;
}

const isSmartbrain = (m) => (m.selector.startsWith('smartbrain/') ? 1 : 0);

/** 同名多行（内置 provider `deepseek/` 与聚合器 `smartbrain/deepseek/` 指向同一型号）时的稳定择一：
 *  已配置 provider 优先 → id 更短 → smartbrain 前缀 → selector 更短 → 字典序。 */
function pickRow(rows) {
  const rank = (m) => [
    CONFIGURED_PROVIDERS.size === 0 || CONFIGURED_PROVIDERS.has(providerOf(m.selector)) ? 0 : 1,
    String(m.id ?? '').length,
    isSmartbrain(m) ? 0 : 1,
    m.selector.length,
    m.selector,
  ];
  return [...rows].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) {
      if (ra[i] < rb[i]) return -1;
      if (ra[i] > rb[i]) return 1;
    }
    return 0;
  })[0];
}

function matchCatalog(base, models, skipped) {
  const lower = base.toLowerCase();
  const exact = models.filter((m) => String(m.name ?? '').toLowerCase() === lower);
  if (exact.length) return { row: pickRow(exact), how: 'exact' };
  const loose = models.filter((m) => String(m.name ?? '').toLowerCase().includes(lower));
  const selectors = new Set(loose.map((m) => m.selector));
  if (selectors.size === 1) return { row: pickRow(loose), how: 'contains' };
  skipped.push({
    aaName: base,
    reason: selectors.size === 0 ? 'no catalog match' : `ambiguous: ${[...selectors].join(', ')}`,
  });
  return null;
}

const speedNum = (speed) => {
  const n = parseFloat(String(speed ?? ''));
  return Number.isFinite(n) ? n : -Infinity;
};

const scoreOf = (index, cost) => index - SCORE_WEIGHT * Math.log(1 + cost / COST_FLOOR);

function buildPool(opts, dataDir, models) {
  const aaRows = JSON.parse(readFileSync(path.join(dataDir, 'aa-data.json'), 'utf8'));
  const dsRows = JSON.parse(readFileSync(path.join(dataDir, 'data.json'), 'utf8'));

  // DeepSWE：按 slug 取 pass_rate 最高行（记住其 avg_cost）
  const dsBest = new Map();
  for (const r of dsRows) {
    const slug = normalizeSlug(r.model);
    const prev = dsBest.get(slug);
    if (!prev || r.pass_rate > prev.pass) dsBest.set(slug, { pass: r.pass_rate, cost: r.avg_cost });
  }

  const excluded = new Set(opts.exclude.map(normCreator));
  const skipped = [];
  const unconfigured = new Map(); // provider → selector 样例（models.yml 没配，可能没凭据）
  const bySelector = new Map();
  for (const row of aaRows) {
    const creator = String(row.creator ?? '').trim();
    if (opts.domestic && !DOMESTIC_CREATORS.has(normCreator(creator))) continue;
    if (excluded.has(normCreator(creator))) continue;
    const speed = speedNum(row.speed);
    if (opts.minSpeed > 0 && speed < opts.minSpeed) continue;

    const base = baseName(row.model);
    const hit = matchCatalog(base, models, skipped);
    if (!hit) continue;
    const m = hit.row;
    const ds = dsBest.get(normalizeSlug(base));
    const cand = {
      selector: m.selector,
      thinking: Array.isArray(m.thinking) ? m.thinking : [],
      hasImage: (m.input ?? []).includes('image'),
      aaName: row.model,
      matchedName: m.name,
      creator,
      index: row.index,
      cost: row.cost,
      speedNum: speed,
      dsPass: ds ? ds.pass : null,
      dsCost: ds ? ds.cost : null,
      how: hit.how,
    };
    cand.score = scoreOf(cand.index, cand.cost);
    // 同一模型的多个 AA effort 变体（GLM-5.3 (max)/(low)）→ 同一个 selector，只留 index 最高的一行。
    const prev = bySelector.get(cand.selector);
    if (!prev || cand.index > prev.index || (cand.index === prev.index && cand.cost < prev.cost)) {
      bySelector.set(cand.selector, cand);
      if (CONFIGURED_PROVIDERS.size && !CONFIGURED_PROVIDERS.has(providerOf(cand.selector))) {
        unconfigured.set(providerOf(cand.selector), cand.selector);
      }
    }
  }
  return { pool: [...bySelector.values()], skipped, unconfigured: unconfigured.keys() };
}

const cmpScore = (a, b) =>
  b.score - a.score ||
  b.speedNum - a.speedNum ||
  (b.dsPass ?? -1) - (a.dsPass ?? -1) ||
  a.selector.localeCompare(b.selector);

// ---------------------------------------------------------------- 角色规则

const tierOf = (cand, kind) => {
  const t = cand.thinking;
  if (!t.length) return null;
  if (kind === 'highest') return t[t.length - 1];
  if (kind === 'low') return t.includes('low') ? 'low' : t[0];
  return t[0]; // first
};

const fmt = (cand, tier) => (tier ? `${cand.selector}:${tier}` : cand.selector);
const fmtScore = (cand) => cand.score.toFixed(2);

function resolveRoles(ranked) {
  const roles = {};
  const put = (role, cand, tier, note) => {
    roles[role] = { cand: cand ?? null, tier: cand ? tier : null, value: cand ? fmt(cand, tier) : null, note };
  };

  const top = ranked[0] ?? null;
  put('default', top, top ? tierOf(top, 'highest') : null,
    top ? `score ${fmtScore(top)} (rank 1)` : 'UNRESOLVED: candidate pool empty');

  const dsRanked = ranked
    .filter((c) => c.dsPass != null)
    .sort((a, b) => b.dsPass - a.dsPass || a.dsCost - b.dsCost || cmpScore(a, b));
  const slow = dsRanked[0] ?? null;
  const slowNote = slow
    ? `DeepSWE PASS@1 ${slow.dsPass}% (max, avg cost $${slow.dsCost})`
    : 'UNRESOLVED: no candidate has a DeepSWE result';
  put('slow', slow, slow ? tierOf(slow, 'highest') : null, slowNote);
  put('plan', slow, slow ? tierOf(slow, 'highest') : null, slowNote);

  const dsCheap = ranked
    .filter((c) => c.dsPass != null && c.dsPass >= 50 && c.dsCost != null)
    .sort((a, b) => a.dsCost - b.dsCost || b.dsPass - a.dsPass || cmpScore(a, b));
  let task = dsCheap[0] ?? null;
  let taskNote = task
    ? `cheapest DeepSWE cost with PASS@1 ≥ 50% ($${task.dsCost}, ${task.dsPass}%)`
    : null;
  if (!task) {
    task = ranked[1] ?? null;
    taskNote = task ? `fallback: score rank 2 (${fmtScore(task)})` : ranked.length ? 'UNRESOLVED: candidate pool has < 2 models' : 'UNRESOLVED: candidate pool empty';
  }
  put('task', task, task ? tierOf(task, 'highest') : null, taskNote);

  put('smol', top, top ? tierOf(top, 'low') : null, top ? 'same as default, thinking=low' : 'UNRESOLVED: default unresolved');
  put('memory', top, top ? tierOf(top, 'low') : null, top ? 'same as default, thinking=low' : 'UNRESOLVED: default unresolved');

  const vision = ranked.find((c) => c.hasImage) ?? null;
  put('vision', vision, vision ? tierOf(vision, 'highest') : null,
    vision ? 'highest score among image-input models' : 'UNRESOLVED: no candidate accepts images');

  const occupied = new Set(
    [roles.default, roles.slow, roles.plan, roles.task, roles.vision, roles.smol]
      .filter((r) => r?.cand)
      .map((r) => r.cand.selector),
  );
  const cheapest = ranked
    .filter((c) => !occupied.has(c.selector))
    .sort((a, b) => a.cost - b.cost || cmpScore(a, b))[0] ?? null;
  const tinyNote = !ranked.length
    ? 'UNRESOLVED: candidate pool empty'
    : cheapest
    ? `cheapest model not used by another role ($${cheapest.cost})`
    : 'UNRESOLVED: every candidate is already used by another role';
  put('commit', cheapest, cheapest ? tierOf(cheapest, 'low') : null, tinyNote);
  put('tiny', cheapest, cheapest ? tierOf(cheapest, 'first') : null, tinyNote);
  put('widget', cheapest, cheapest ? tierOf(cheapest, 'first') : null, tinyNote);

  const advisor = top ? ranked.find((c) => c.creator !== top.creator) ?? ranked[1] ?? null : null;
  put('advisor', advisor, advisor ? tierOf(advisor, 'highest') : null,
    advisor ? `top score with a creator different from default (${top.creator})` : top ? 'UNRESOLVED: no alternative creator' : 'UNRESOLVED: candidate pool empty');

  // 回退链：每角色一条单元素链
  const chains = {};
  if (ranked.length) {
    const usedAnywhere = new Set(Object.values(roles).filter((r) => r.cand).map((r) => r.cand.selector));
    for (const role of ROLE_ORDER) {
      const self = roles[role]?.cand;
      if (!self) continue;
      const pick = ranked.find((c) => c.creator !== self.creator && !usedAnywhere.has(c.selector)) ??
        ranked.find((c) => c.selector !== self.selector) ?? null;
      if (pick && pick.selector !== self.selector) chains[role] = fmt(pick, tierOf(pick, 'highest'));
    }
  }
  return { roles, chains };
}

// ---------------------------------------------------------------- YAML 读写

const TOP_KEY = /^[A-Za-z0-9_.-]+:/;
const indentOf = (line) => line.length - line.trimStart().length;

function findTopBlock(lines, key) {
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\s|$)`);
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (TOP_KEY.test(lines[i])) { end = i; break; }
  }
  while (end - 1 > start && lines[end - 1].trim() === '') end--;
  return { start, end };
}

/** 顶层块内 indent 深度的子键块（含表头行），块尾吃掉后续空行之外的一切更深缩进行 */
function findChildBlock(lines, block, key, indent) {
  const header = ' '.repeat(indent) + key + ':';
  const start = lines.findIndex((l, i) => i > block.start && i < block.end && l.trimEnd() === header);
  if (start < 0) return null;
  let end = block.end;
  for (let i = start + 1; i < block.end; i++) {
    if (lines[i].trim() !== '' && indentOf(lines[i]) === indent) { end = i; break; }
  }
  while (end - 1 > start && lines[end - 1].trim() === '') end--;
  return { start, end };
}

function roleLines(indent) {
  return ROLE_ORDER.filter((r) => roles[r]?.value).map((r) => `${' '.repeat(indent)}${r}: ${roles[r].value}`);
}

function chainLines() {
  const names = ROLE_ORDER.filter((r) => chains[r]);
  if (!names.length) return [];
  const out = ['  fallbackChains:'];
  for (const r of names) out.push(`    ${r}:`, `      - ${chains[r]}`);
  return out;
}

function presetLines(name) {
  const out = [`  ${name}:`, '    modelRoles:', ...roleLines(6), '    defaultThinkingLevel: low'];
  return out;
}

function replaceBlock(lines, block, replacement) {
  lines.splice(block.start, block.end - block.start, ...replacement);
}

function applyConfig(originalLines, presetName) {
  const lines = [...originalLines];

  // 1) modelRoles 整块
  const rolesNew = ['modelRoles:', ...roleLines(2)];
  const rolesBlock = findTopBlock(lines, 'modelRoles');
  if (rolesBlock) replaceBlock(lines, rolesBlock, rolesNew);
  else lines.push(...rolesNew);

  // 2) retry.fallbackChains 子块
  const chainsNew = chainLines();
  const retryBlock = findTopBlock(lines, 'retry');
  if (retryBlock) {
    const sub = findChildBlock(lines, retryBlock, 'fallbackChains', 2);
    if (sub) {
      if (chainsNew.length) replaceBlock(lines, sub, chainsNew);
      else lines.splice(sub.start, sub.end - sub.start);
    } else if (chainsNew.length) {
      lines.splice(retryBlock.start + 1, 0, ...chainsNew);
    }
  } else if (chainsNew.length) {
    lines.push('retry:', ...chainsNew);
  }

  // 3) modelPresets.<preset> 子块（按名字典序插入，保持输出稳定）
  const presetNew = presetLines(presetName);
  const presetBlock = findTopBlock(lines, 'modelPresets');
  if (presetBlock) {
    const existing = findChildBlock(lines, presetBlock, presetName, 2);
    if (existing) {
      replaceBlock(lines, existing, presetNew);
    } else if (lines[presetBlock.start].trim() === 'modelPresets:') {
      const headers = [];
      for (let i = presetBlock.start + 1; i < presetBlock.end; i++) {
        if (lines[i].trim() !== '' && indentOf(lines[i]) === 2 && lines[i].trimEnd().endsWith(':')) headers.push(i);
      }
      const before = headers.find((i) => lines[i].trim().replace(/:$/, '') > presetName);
      if (before !== undefined) lines.splice(before, 0, ...presetNew);
      else lines.splice(presetBlock.end, 0, ...presetNew);
    } else {
      // `modelPresets:` 不是空块（理论上不会发生）── 退化为紧接表头插入
      lines.splice(presetBlock.start + 1, 0, ...presetNew);
    }
  } else {
    lines.push('modelPresets:', ...presetNew);
  }

  return lines;
}

function validate(originalLines, nextLines) {
  const topKeys = (arr) => arr.filter((l) => TOP_KEY.test(l)).map((l) => l.slice(0, l.indexOf(':')));
  const before = topKeys(originalLines);
  const after = topKeys(nextLines);
  const problems = [];
  for (const k of before) if (!after.includes(k)) problems.push(`lost top-level key \`${k}\``);
  for (const k of ['modelRoles', 'retry', 'modelPresets']) {
    if (!after.includes(k)) problems.push(`missing generated block \`${k}\``);
  }
  const dupes = after.filter((k, i) => after.indexOf(k) !== i);
  if (dupes.length) problems.push(`duplicate top-level keys: ${[...new Set(dupes)].join(', ')}`);
  return problems;
}

// ---------------------------------------------------------------- 报告

function report(roles, chains, skipped, opts) {
  const rows = ROLE_ORDER.filter((r) => roles[r]);
  const head = ['role', 'selector', 'AA', 'cost', 'tok/s', 'DS', 'rule'];
  const data = rows.map((r) => {
    const { cand, value, note } = roles[r];
    return [
      r,
      value ?? '-',
      cand ? String(cand.index) : '-',
      cand ? `$${cand.cost}` : '-',
      cand ? (Number.isFinite(cand.speedNum) ? String(cand.speedNum) : '--') : '-',
      cand ? (cand.dsPass == null ? '-' : `${cand.dsPass}%`) : '-',
      note,
    ];
  });
  const widths = head.map((h, i) => Math.max(h.length, ...data.map((d) => d[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  console.log(line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const d of data) console.log(line(d));

  const unresolved = rows.filter((r) => !roles[r].value);
  if (skipped.length) {
    console.log('\nskipped AA rows (no unique catalog match):');
    for (const s of skipped) console.log(`  - ${s.aaName}  →  ${s.reason}`);
  }
  if (unresolved.length) {
    console.log(`\nUNRESOLVED roles (no candidate survived the filters): ${unresolved.join(', ')}`);
  }
  console.log(`\nfilters: domestic=${opts.domestic} exclude=[${opts.exclude.join(',')}] min-speed=${opts.minSpeed}`);
  const chained = ROLE_ORDER.filter((r) => chains[r]);
  console.log(`fallback chains: ${chained.length ? chained.map((r) => `${r}→${chains[r]}`).join(', ') : 'none'}`);
}

// ---------------------------------------------------------------- main

const opts = parseArgs(process.argv.slice(2));
const dataDir = path.resolve(opts.dir);
const modelsPath = opts.out ? path.resolve(opts.out) : path.join(dataDir, 'omp-models.json');

ensureLeaderboardData(dataDir, opts.dryRun);
const models = loadModels(modelsPath, opts.dryRun);
const { pool, skipped, unconfigured } = buildPool(opts, dataDir, models);
const ranked = [...pool].sort(cmpScore);
const { roles, chains } = resolveRoles(ranked);

report(roles, chains, skipped, opts);
if (CONFIGURED_PROVIDERS.size) {
  for (const [provider, sample] of unconfigured) {
    console.warn(`warning: provider \`${provider}\` (${sample}) is not in models.yml — no credentials there, calls may fail`);
  }
}

const configPath = CONFIG_PATH;

const raw = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const original = raw.length ? raw.split(/\r?\n/) : [];
if (raw.endsWith(eol)) original.pop(); // 保留末尾换行语义
const next = applyConfig(original, opts.preset);

const problems = validate(original, next);
if (problems.length) {
  console.error(`\ngen-roles: refusing to write ${configPath}:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}

const nextText = next.join(eol) + eol;
console.log(`\nconfig: ${configPath}${raw ? '' : ' (new file)'}  preset: ${opts.preset}`);

if (opts.dryRun) {
  console.log('\n[dry-run] would replace `modelRoles:` block with:');
  console.log(['modelRoles:', ...roleLines(2)].join(eol));
  console.log('\n[dry-run] would replace `retry.fallbackChains:` with:');
  console.log(chainLines().length ? chainLines().join(eol) : '(removed — no chains selected)');
  console.log(`\n[dry-run] would add/replace preset \`${opts.preset}\` with:`);
  console.log(presetLines(opts.preset).join(eol));
  console.log('\n[dry-run] nothing written.');
} else {
  const tmp = `${configPath}.tmp-${process.pid}`;
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(tmp, nextText);
  try {
    renameSync(tmp, configPath);
  } catch (e) {
    // Windows：运行中的 omp 可能持有 config.yml 句柄，rename 会被拒（EPERM/EBUSY）→ 退化为直接覆写
    if (e.code !== 'EPERM' && e.code !== 'EBUSY') throw e;
    writeFileSync(configPath, nextText);
    unlinkSync(tmp);
  }
  console.log(`wrote ${nextText.split(eol).length} lines.`);
}
