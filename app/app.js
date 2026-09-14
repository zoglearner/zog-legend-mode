'use strict';
/* ============================================================================
   ZOG · 单机版 —— 接真实数据的前端（v1）
   ----------------------------------------------------------------------------
   数据源：../assets/data（§5.2 三层分离）
     manifest.json                全局清单（届列表 + dictVersion + buildId）
     dict.json                    全局字典（sire / damSire / breeder / owner /
                                  stable / jockey / sale / cross，字段皆字典下标）
     if_events.json               IF 事件（手写、运行时叠加）
     seasons/<出生年>/
       season.json                届元信息 + 段网格 + 节点切点表 + 规则 + 字面表
       pool.json                  候选池（零赛果）
       segments.json              段汇总：每匹 × 6 段 [分,1着,2着,3着,着外]
       races/s1..s6.json          逐场明细，按 6 段切

   本文件所有派生值一律「按节点现算」（§4.3）：分数 / 成绩串 / 赛 n 场 / 赛果表
   都从 segments 或 races 现算，不预存任何节点快照。

   缓存（2026-09-14）：数据包是「同一个 URL 内容会变」的东西（重建数据不换文件名），
   而分档请求原用 force-cache ⇒ 老玩家手上的旧数据永远不会更新（数据修了也白修）。
   现在每次启动**先以 no-store 取 manifest**（仅 200B），拿它的 buildId 给其余所有请求
   挂 `?v=<buildId>`：数据一重建 URL 就变，force-cache 反而成了「同版本复用」的好处
    —— pool.json 那 1.5MB 在同一版本内仍只下一次，不吃额外流量。

   ⚠️ 已知待办（与数据侧同步）：
     IF 的触发掷骰按 §4.8 应在「届构建期掷定并固化进 pool.json」，但当前构建
     产物尚未写入该字段 ⇒ 本前端退一步在「名单锁定那一刻」掷一次并随存档固化
     （同一次存档重进不重掷）。数据侧补上后，这里只需改成读字段。
   ============================================================================ */

/* ------------------------------------------------------------------ 常量 */

const DATA_BASE = new URL('../assets/data/', document.baseURI).href;
const MAX = 10;                 /* 名单满额（5 牡 5 牝） */
const REFRESH_PER_ROUND = 3;    /* 每轮「整批换池」次数（2026-09-13 用户口径 · banushi-game 式）：
                                  一轮 ＝ 抽一批 10 条候选 → 最多换池 3 次 → 确认 1 匹 → 下一轮；
                                  次数**换轮即重置**（见 startRound）。
                                  记法从「整局 30 次」改成「每轮 3 次」后整局上限不变（10 轮 × 3 ＝ 30），
                                  但分布变了 —— 整局共用时玩家会把 30 次一口气烧在第一轮（那一批刚好全不顺眼），
                                  后 9 轮反而一次也换不动；而「这一批我全都不想要」的需求每轮是等量的。
                                  另：「确认加入名单」本身就会免费换一批新候选（见 confirm 分支），
                                  换池次数只花在「这一批我全都不想要」上。池子面：每届 5,188 匹，
                                  整局上限 310 匹（≈5.98%）。 */
/* 保底（2026-09-13 用户口径，抽卡式）——**每批 10 匹里固定含一个「保底槽」**：
     该槽从「全届（全窗）赏金第 31~100 名」里随机抽一匹，并有 UP_P 的概率**升格**为前 30 名；
     槽位在批内随机（不是固定第几位），其余 9 匹照常从全池随机。每批独立掷，**不保留任何跨轮状态**。
   为什么是这个形态：早先两版都失败 —— ① 保底只作用于每轮首批 ⇒ 一换池就把保底马扔掉（越刷新越差）；
   ② 保底马整轮固定 ⇒ 刷新时有一匹马纹丝不动，玩家一眼看出被保底。抽卡式两个问题都没有：
   每批重掷、位置随机，看起来就是「十连保底」这条明规则；顺带把实现从跨轮状态简化成纯函数。
   口径与界面分数同源：按「全窗赏金」排名（见 guardSlot / guardLayers），按届缓存。
   实测（合规玩法、两届各 250 局）：终局总分 16.8k→30.5k（2021）/ 15.3k→24.2k（2022）、
   出 IF 概率 2%→8% / 0%→4% —— 与「每局 3~5 次轮级保底」那版**强度几乎相同**（30.4k / 24.4k），
   但不可察觉、且无状态。注：这是**隐藏机制**，不写进规则说明页（用户口径：不需要提示）。 */
const GUARD = { lo: 31, hi: 100, upP: 0.25, upRank: 30 };
const SAVE_KEY = 'zog.save.v1';

/* 赛事级别（构建期 grade_cd → 数字，见 tools/build_season_pack.py） */
const GRADE = { 4: 'G3', 5: 'G2', 6: 'G1', 7: 'JG3', 8: 'JG2', 9: 'JG1' };
/* 异常区分（i_jyo_cd）—— 非完走标签，绝不裸显「0 着」 */
const NF = { 0: '未施行', 1: '取消', 2: '発走除外', 3: '競走除外', 4: '中止', 5: '失格', 6: '降着', 7: '再騎乗' };

/* 叙事锚点挂「日期」不挂节点序号 ⇒ 换档时叙事零改动（§4.3） */
const NODE_META = {
  half: [
    { t: 'NODE 1', k: '2 岁后半', d: '2 岁末结算 · 逐条出分 ＋ 规则陷阱' },
    { t: 'NODE 2', k: '3 岁经典季', d: '经典季结算 · 真名揭晓 ＋ 逐场解锁' },
    { t: 'NODE 3', k: '3 岁收官', d: '终局结算 · 总分定格 ＋ IF 世界线' }
  ],
  quarter: [
    { t: 'NODE 1', k: '2 岁夏', d: '出道潮 · 此时仅部分马已出道' },
    { t: 'NODE 2', k: '2 岁秋', d: '＝ 2 岁末结算 · 出分 ＋ 规则陷阱' },
    { t: 'NODE 3', k: '3 岁冬春', d: '前哨战 · 逐场仍未公开' },
    { t: 'NODE 4', k: '3 岁经典季', d: '＝ 经典季结算 · 真名揭晓 ＋ 逐场解锁' },
    { t: 'NODE 5', k: '3 岁秋', d: '秋華賞 / 菊花賞 段 · 逐场仍未公开' },
    { t: 'NODE 6', k: '3 岁收官', d: '＝ 终局结算 · 总分定格 ＋ IF 世界线' }
  ]
};

/* -------------------------------------------------------------- 数据层 */

const DB = { manifest: null, dict: null, ifEvents: null };
const SV = {};                       /* seasonId -> { meta, pool, poolBy, seg, races:{}, segLoaded } */
let DATA_V = null;                   /* 数据包版本（manifest.buildId）；所有分档请求带它 ⇒ 换数据即换 URL */

/* manifest 是唯一「必须每次问网」的文件（数据换了只有它不会变 URL，见文件头「缓存」）
   —— 但它只有 200B，且是其余一切的版本来源。 */
async function jgetManifest() {
  const res = await fetch(DATA_BASE + 'manifest.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('manifest.json → HTTP ' + res.status + ' ' + res.statusText);
  return res.json();
}

async function jget(rel) {
  const suffix = DATA_V ? '?v=' + encodeURIComponent(DATA_V) : '';
  const res = await fetch(DATA_BASE + rel + suffix, { cache: 'force-cache' });
  if (!res.ok) throw new Error(rel + ' → HTTP ' + res.status + ' ' + res.statusText);
  return res.json();
}

async function loadSeason(id) {
  if (SV[id]) return SV[id];
  const [meta, pool, seg] = await Promise.all([
    jget('seasons/' + id + '/season.json'),
    jget('seasons/' + id + '/pool.json'),
    jget('seasons/' + id + '/segments.json')
  ]);
  const poolBy = new Map(pool.map(c => [c.ketto, c]));
  SV[id] = { meta, pool, poolBy, seg, races: {}, segLoaded: 0 };
  return SV[id];
}

/* 逐场明细按段懒加载（§5.2「没拉过的段在玩家设备上不存在」） */
async function ensureSegments(uptoIdx) {
  const s = S();
  if (s.segLoaded >= uptoIdx + 1) return;
  const need = [];
  for (let i = s.segLoaded; i <= uptoIdx; i++) need.push(jget('seasons/' + state.season + '/races/s' + (i + 1) + '.json'));
  const got = await Promise.all(need);
  got.forEach((obj, n) => { s.races[s.segLoaded + n] = obj; });
  s.segLoaded = uptoIdx + 1;
}

/* -------------------------------------------------------------- 取值器 */

const S = () => SV[state.season];
const D = () => DB.dict;
const meta = () => S().meta;
const byKet = k => S().poolBy.get(k);
const sireOf = c => D().sire[c.sire];
const damSireOf = c => D().damSire[c.damSire];
const breederOf = c => D().breeder[c.breeder];
/* 实体不存在时（下标 -1）返回 null —— 由渲染层决定显示「—」 */
const ownerOf = c => (c.owner >= 0 ? D().owner[c.owner] : null);
const stableOf = c => (c.stable >= 0 ? D().stable[c.stable] : null);
const keiroOf = c => meta().keiroNames[c.keiro] || '';
const damTagOf = c => meta().damTagText[String(c.damTag)] || '';
/* 注：saleOf（拍卖会名）已随 2026-09-13「落札只出价」的裁定撤下 —— dict.sale 仍在数据包内，
   但前端不再有消费方；数据完整性扫描仍会校验 price[0] 的下标合法性。 */

/* -------------------------------------------------------------- 节点口径 */

function nodeCuts() { const m = meta(); return m.paces[state.pace].map(i => m.cuts[i]); }
const paceLen = () => nodeCuts().length;
const cutOf = k => nodeCuts()[k - 1];
const lastCut = () => cutOf(paceLen());
const nodeAt = ds => {                       /* 该日期在第几个节点结算（含当日）；超出全窗 → 99 */
  const nc = nodeCuts();
  for (let i = 0; i < nc.length; i++) if (nc[i] >= ds) return i + 1;
  return 99;
};
const revealNode = c => (c.debut ? nodeAt(c.debut.replace(/-/g, '.')) : Infinity);
const trapNode = () => nodeAt(meta().anchors.trap);
const nameNode = () => nodeAt(meta().anchors.names);
const cutNum = ds => Number(String(ds).replace(/\./g, ''));

/* 马主 / 厩舎：选马期按三档披露掷定；出道即解锁（§5.1 线 A）。
   ⚠️「下标 -1（无此实体）」与「有但未获披露」必须**同形**，一律「？？」（2026-09-13 修正）。
   理由：源库里厩舎是赛果记录的副产品 —— stable=-1 与「从未出赛」**完全重合**
   （2021 届 217/5,188、2022 届 220/5,182，各 4.2%；从未出赛但 stable≥0 者 0 匹）。
   早先前者对「—」、后者对「？？」⇒ 玩家只要认出「—」，就知道这匹马从未出道 ＝ 零赛果，
   等于把（线 B 的）赛果情报白送出去。设计口径为「始终无出赛记录者不揭晓」⇒ 未揭晓态同形。 */
const ownVisible = (c, k) => c.owner >= 0 && (!!c.revealOwner || (!!c.debut && revealNode(c) <= k));
const stabVisible = (c, k) => c.stable >= 0 && (!!c.revealStable || (!!c.debut && revealNode(c) <= k));
const ownCell = (c, k) => ownVisible(c, k) ? esc(ownerOf(c)) : '<span class="muted">？？</span>';
const stabCell = (c, k) => stabVisible(c, k) ? esc(stableOf(c)) : '<span class="muted">？？</span>';

/* ---------------------------------------------------------- 计分 / 成绩串 */

/* 段真值 → 截至某切点（含当日）的累计。全案唯一的「节点口径」实现。 */
function cumFrom(seg, cut) {
  const grid = meta().cuts;
  let score = 0; const r = [0, 0, 0, 0];
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] > cut) break;
    const x = seg[i] || [0, 0, 0, 0, 0];
    score += x[0];
    for (let j = 1; j <= 4; j++) r[j - 1] += x[j];
  }
  const n = r[0] + r[1] + r[2] + r[3];
  /* 0 场显示 —（只可能来自「全部未発走」）；只要発走过一次就记 1 场、落着外格 */
  return { score, rec: n ? r.join('-') : '—', n, r };
}

/* 段真值（含 IF 叠加）—— 明细表的 分数 / 成绩串 / 赛 n 场 都从它现算 */
function cum(ketto, cut) { return cumFrom(segOf(ketto), cut); }

/* ------------------------------------------------ IF 叠加：落在**段**上（§4.8） */
/* ⚠️ IF 改写必须改**段真值**，不能只在 races 那一侧另算一套分数。
   segments.json 的段是计分数据唯一的落地形态（§4.3）：明细表的 分数 / 成绩串 全部由 cum() 现算。
   若 IF 只改写逐场（ifRewrite）而段原封不动，凡读段的口径看到的就还是改写前的旧值 ——
   「IF 事件好像没有改明细表里的 seg」（2026-09-14 用户报）。§4.8 的原话也是「改写只动受影响的段」。

   叠加的输入刻意取**事件表**而非逐场文件：每条 op 自带改写前真值（wasFinish / wasPrize）
   与改写后真值（finish / prize / nf），两侧一对正好就是那一段的增减量。
   好处是段真值不必等 races 拉下来就能改写 —— 逐场只是段的下钻视图，从节点 2 才加载，
   而段从节点 1 起就一直在用。
   两条前提由 tools/check_if_ops.py 把住：非 add 的 op 必须能在数据包里找到那一场（否则「减」会
   把格子减成负数）；add 的场次库里必须还没有（否则「加」会重复计数）—— 一句话，段侧只认「日期」，
   逐场侧还要认「赛名」，两者要一致就必须让事件表把赛名写到能精确命中（该脚本会报「简称/异名」）。 */

/* 该日期落在第几段（0 起）—— 与构建期 tools/build_season_pack.py 的 seg_index 同一口径 */
function segOfDate(ds) {
  const d = String(ds).replace(/-/g, '.');
  const grid = meta().cuts;
  for (let i = 0; i < grid.length; i++) if (grid[i] >= d) return i;
  return -1;
}

/* 一场比赛在段里的计数增量：完走落 1着/2着/3着 格、≥4 落着外格；
   非完走只有「中止 4 / 失格 5」算 1 场、归着外格 —— 口径与 recFromRaces 同源，两处必须同步改。 */
function segCountInto(s, f, nf, sign) {
  if (f >= 1) s[f <= 3 ? f : 4] += sign;
  else if (nf === 4 || nf === 5) s[4] += sign;
}

/* 一匹马的段真值：命中 IF 且已定格 ⇒ 叠加改写，否则原样返回 */
function segOf(ketto) {
  const raw = S().seg.seg[ketto] || [];
  const hits = (state.ifHits || []).filter(h => h.hero === ketto);
  /* 未定格 ⇒ 仍是改写前的段真值（§4.8：IF 在终局节点才兑现，先于总分定格爆发） */
  if (!hits.length || !state.seenIf) return raw;
  const out = meta().cuts.map((_, i) => (raw[i] || [0, 0, 0, 0, 0]).slice());
  for (const ev of hits) for (const op of ev.rewrite) {
    const si = segOfDate(op.race[0]);
    if (si < 0 || !out[si]) { console.warn('[IF] 场次落在段网格之外：', ev.name, op.race[0]); continue; }
    const s = out[si];
    if (op.op !== 'add') {                            /* 抹掉改写前的这一场（add ＝ 库里本来没有 ⇒ 只加不减） */
      s[0] -= op.wasPrize || 0;
      segCountInto(s, op.wasFinish, op.wasNf, -1);
    }
    if (op.op !== 'drop') {                           /* 写上改写后的这一场 */
      s[0] += op.prize || 0;
      segCountInto(s, op.finish, op.nf, +1);
    }
  }
  return out;
}

/* 逐场真值 → 分数 / 成绩串（非完走口径与段真值同源，已全量比对一致） */
function recFromRaces(rows) {
  const r = [0, 0, 0, 0];
  let score = 0;
  for (const x of rows) {
    if (x.f >= 1) {                                  /* 完走（含降着 disqualified_and_placed） */
      if (x.f <= 3) r[x.f - 1]++; else r[3]++;
      if (x.f <= 5) score += x.p || 0;               /* Lite 只认前 5 名 */
    } else {
      const nf = x.nf || 0;
      if (nf === 4 || nf === 5) r[3]++;              /* 中止 / 失格 ⇒ 算 1 场、归着外格 */
      /* 取消 1 / 発走除外 2 / 競走除外 3 / 未施行 0 / 再騎乗 7 ⇒ 不算 */
    }
  }
  const n = r[0] + r[1] + r[2] + r[3];
  return { score, rec: n ? r.join('-') : '—', n, r };
}

/* 逐场轨迹（截至某切点，含当日） */
function traceOf(ketto, cut) {
  const lim = cutNum(cut), out = [];
  const bag = S().races;
  for (const idx of Object.keys(bag)) {
    const rows = bag[idx][ketto];
    if (rows) for (const r of rows) if (r.d <= lim) out.push(r);
  }
  out.sort((a, b) => a.d - b.d);
  return out;
}

/* 需要的段数（下一个未拉取的段序号，0-based）：节点 2 起才需要逐场 */
function segIndexOfCut(cut) {
  const grid = meta().cuts;
  let k = -1;
  for (let i = 0; i < grid.length; i++) if (grid[i] <= cut) k = i;
  return k;
}

/* ------------------------------------------------------------ 规则陷阱 */

/* 三类约束的违规集合（§4.5）。返回 [{label, set, ...}]，空 = 合规。 */
function violations(roster) {
  const out = [];
  const R = roster.map(byKet).filter(Boolean);
  const males = R.filter(c => c.sex === 'M').map(c => c.ketto);
  const females = R.filter(c => c.sex === 'F').map(c => c.ketto);
  if (males.length > 5) out.push({ label: '性别', text: '牡 ' + males.length + ' 匹 ＞ 5', set: new Set(males) });
  if (females.length > 5) out.push({ label: '性别', text: '牝 ' + females.length + ' 匹 ＞ 5', set: new Set(females) });

  const t1 = R.filter(c => c.breederTier === 1).map(c => c.ketto);
  const t12 = R.filter(c => c.breederTier <= 2).map(c => c.ketto);
  if (t1.length > 5) out.push({ label: '牧场档位', text: '档 1 ' + t1.length + ' 匹 ＞ 5', set: new Set(t1) });
  if (t12.length > 7) out.push({ label: '牧场档位', text: '档 1＋档 2 ' + t12.length + ' 匹 ＞ 7', set: new Set(t12) });

  const g = {};
  R.forEach(c => { (g[c.sire] = g[c.sire] || []).push(c.ketto); });
  const over = Object.keys(g).filter(k => g[k].length > 2);
  if (over.length) {
    const names = over.map(k => sireOf({ sire: +k }) + '(' + g[k].length + ')').join('、');
    out.push({ label: '同父产驹', text: '同父 ＞ 2：' + names, set: new Set(over.flatMap(k => g[k])) });
  }
  return out;
}

/* 迭代移除：每轮取「所属违规集合数最多」的马中 ZOG 分最高者（§4.5） */
function settleTrap() {
  const cut = meta().anchors.trap;
  let roster = state.roster.slice();
  const removed = [];
  for (let guard = 0; guard < 12; guard++) {
    const vs = violations(roster);
    if (!vs.length) break;
    const cnt = new Map();
    vs.forEach(v => v.set.forEach(k => cnt.set(k, (cnt.get(k) || 0) + 1)));
    let best = null;
    cnt.forEach((c, k) => {
      if (!best || c > best.c || (c === best.c && cum(k, cut).score > cum(best.k, cut).score)) best = { k, c };
    });
    if (!best) break;
    roster = roster.filter(k => k !== best.k);
    removed.push({
      ketto: best.k,
      sets: vs.filter(v => v.set.has(best.k)).map(v => v.text),
      round: removed.length + 1,
      setsCount: best.c
    });
  }
  return removed;
}

/* ------------------------------------------------------------- IF 世界线 */

function normDate(s) { return Number(String(s).replace(/-/g, '')); }

/* 把主角的逐场按事件 ops 改写；返回改写后的行（已按日期排序）。
   匹配是两步：先「日期 ＋ 赛事名」精确匹配；失败再退化为「当日仅一场」。
   为什么需要兜底：事件表里常用官方简称（チャンピオンズC / ジャパンC / オパールS），而库里是全称
   （…カップ / …ステークス）—— 精确匹配会落空，而落空的 drop 表现为「新的场次加进来了、老的没去掉」
   （2026-09-13 用户报）；落空的 set 则是改写完全没生效。数据侧同时已把这三条改成全称。
   【2026-09-14 用户报「名次改了，骑手忘了改」】改写过去只动 f / p 两个字段，行上的鞍上（j）与级别（g）
   仍留着现实的 —— add 更是直接钉死 -1 / 0（表上就是「—」和不带级别）；于是 02 / 19 的文案里
   明明换了人（戸崎圭太 / Ｃ．デム），比赛表上还是旧骑手。现在 jockey / grade 由事件表写明、这里落地，
   与 f / p 同一套「写明才覆盖」。
   鞍上为什么在数据里写**名字**而不是下标：事件表是手写的、不随数据包重建，而下标会因一次字典重建
   整体位移 —— 名字写错能被 tools/check_if_ops.py 当场抓住，下标写错只会静默指到另一个人身上。 */
let jkIndex = null;                          /* dict.json.jockey 的名字 → 下标（全局字典，一局内不变） */
function jockeyIdx(name) {
  if (!jkIndex) { jkIndex = new Map(); D().jockey.forEach((n, i) => jkIndex.set(n, i)); }
  const i = jkIndex.get(name);
  if (i === undefined) console.warn('[IF] 骑手名不在 dict.json.jockey 里：', name);
  return i === undefined ? -1 : i;
}

function ifRewrite(ketto) {
  const rows = traceOf(ketto, lastCut()).map(r => ({ ...r }));
  const ops = [];
  state.ifHits.filter(h => h.hero === ketto).forEach(ev => ev.rewrite.forEach(op => ops.push({ ev, op })));
  for (const item of ops) {
    const op = item.op, d = normDate(op.race[0]), nm = op.race[1];
    const jk = op.jockey ? jockeyIdx(op.jockey) : -1;      /* 没写鞍上 ＝ 这一场不动鞍上 */
    let i = rows.findIndex(x => x.d === d && x.r === nm);
    if (i < 0) {
      const day = rows.map((x, n) => [x, n]).filter(p => p[0].d === d);
      if (day.length === 1) i = day[0][1];                 /* 当日仅一场 ⇒ 认定就是它 */
    }
    if (op.op === 'drop') { if (i >= 0) rows.splice(i, 1); else console.warn('[IF] drop 找不到场次', item.ev.name, nm, d); }
    else if (op.op === 'add') {
      if (i >= 0) { rows[i].f = op.finish; rows[i].p = op.prize; rows[i].rw = true; }   /* 已有同名同日 ⇒ 覆盖，不追加 */
      /* 库里没有这一场 ⇒ 行是凭空造的，级别与鞍上只能取自事件表（缺了就是「无级别 / —」） */
      else rows.push({ d, r: nm, g: op.grade ?? 0, j: jk, f: op.finish, p: op.prize, added: true });
    }
    else if (op.op === 'set') { if (i >= 0) { rows[i].f = op.finish; rows[i].p = op.prize; rows[i].rw = true; } else console.warn('[IF] set 找不到场次', item.ev.name, nm, d); }
    else if (op.op === 'prize') { if (i >= 0) { rows[i].p = op.prize; rows[i].rw = true; } else console.warn('[IF] prize 找不到场次', item.ev.name, nm, d); }
    else if (op.op === 'nf') { if (i >= 0) { rows[i].f = 0; rows[i].p = 0; rows[i].nf = op.nf; rows[i].rw = true; } else console.warn('[IF] nf 找不到场次', item.ev.name, nm, d); }
    /* 已有行上的鞍上 / 级别：同样「写明才覆盖」。
       ⚠️ drop 必须排除 —— 上面已经 splice 掉了那一行，此时 i 指向的已经换成邻行，再写就改错马。 */
    if (op.op !== 'drop' && i >= 0) {
      if (jk >= 0) rows[i].j = jk;
      if (op.grade !== undefined) rows[i].g = op.grade;
    }
  }
  rows.sort((a, b) => a.d - b.d);
  return rows;
}

/* IF 的最终分数 / 成绩串。rows（改写后的逐场）只用于逐场下钻视图；
   分数 / 成绩串本身与段真值（cum → segOf）同源，两处必须算出同一个数。 */
function ifResult(ketto) {
  const rows = ifRewrite(ketto);
  const res = recFromRaces(rows);
  /* 基准＝**改写前**的段真值：不能用 cum()（它已含叠加），否则 delta 恒为 0 */
  const base = cumFrom(S().seg.seg[ketto] || [], lastCut()).score;
  return { rows, score: res.score, rec: res.rec, n: res.n, delta: res.score - base, base };
}

/* 计分：IF 叠加已在 segOf/cum 里落地，这三处只需读同一个口径
   （不再为 IF 主角单开一条分支 —— 那正是「两套口径」的来源） */
function finalScore(ketto) { return cum(ketto, lastCut()).score; }
function scoreAt(ketto, cut) { return cum(ketto, cut).score; }
function recAt(ketto, cut) { return cum(ketto, cut).rec; }

/* 触发掷骰：名单锁定那刻掷一次并固化（见文件头 ⚠️） */
function rollIfs() {
  const pool = (DB.ifEvents.events || []).filter(e => e.season === state.season);
  const on = e => state.roster.includes(e.hero);
  const base = DB.ifEvents.probability.base;
  const chained = DB.ifEvents.probability.chained;
  const hit = {};

  /* ① 组联动：组内任意一条在名单 ⇒ 该组上膛、按基准掷一次，中了组内命中的条目一起兑现 */
  const groups = {};
  pool.forEach(e => { if (e.group && on(e)) (groups[e.group] = groups[e.group] || []).push(e); });
  Object.keys(groups).forEach(g => {
    const ok = Math.random() < base;
    groups[g].forEach(e => { hit[e.id] = ok; });
  });

  /* ② 独立条 */
  pool.filter(e => !e.group && !e.dependsOn && on(e)).forEach(e => { hit[e.id] = Math.random() < base; });

  /* ③ 前置依赖：前置在名单里 ⇒ 前置中则本条 50%、前置未中则本条不触发；
        前置不在名单里 ⇒ 本条独立按 20% 掷（文案里的前情照常保留） */
  const byId = {};
  pool.forEach(e => { byId[e.id] = e; });
  pool.filter(e => e.dependsOn && !e.group).forEach(e => {
    if (!on(e)) return;
    const dep = byId[e.dependsOn];
    if (dep && on(dep)) {
      if (hit[dep.id] === undefined) hit[dep.id] = Math.random() < base;
      hit[e.id] = hit[dep.id] ? (Math.random() < chained) : false;
    } else {
      hit[e.id] = Math.random() < base;
    }
  });

  state.ifHits = pool.filter(e => hit[e.id]);
}

/* 被「那一刀」移出名单的马，IF 命中一并作废（2026-09-14 用户报「违规被扣掉的马依然会触发 IF 线」）。
   时序是硬伤：掷定在名单锁定那刻（节点 0，见上），而谁会被移除要到节点 2 结算陷阱才知道 ——
   因此只能事后回收，没法在掷的时候就绕开它。
   为什么在源头动刀：卡片、净增分、「N 处」计数、结算页内嵌的同一份 ifBody()，
   读的都是 state.ifHits 这一份数据 —— 分散到各渲染处过滤，迟早漏掉一处。
   作废后连带自洽：结算页「那一刀」卡片里的「本可贡献 X」也回到它的真值分，
   不再显示一条并不存在的世界线上的分数。 */
function purgeIfsOfRemoved() {
  const gone = new Set((state.trapRemoved || []).map(r => r.ketto));
  if (!gone.size) return;
  state.ifHits = state.ifHits.filter(h => !gone.has(h.hero));
}

/* ---------------------------------------------------------------- 状态 */

const state = {
  screen: 'title',
  season: null,
  pace: null,
  mode: 'lite',
  roster: [],        /* 已确认入名单的 ketto（按选取顺序） */
  batch: [],         /* 当前 10 条候选的 ketto */
  seen: {},          /* 本局见过的全部候选 ketto（供「错过的马」）：进存档 */
  pick: null,        /* 当前选中未确认的 ketto */
  pickOpen: false,   /* 抽取弹窗是否展开（2026-09-13：与 pick 一起进存档，刷新/续玩原样恢复） */
  refreshes: REFRESH_PER_ROUND,   /* 本轮剩余的整批换池次数（见 REFRESH_PER_ROUND）：换轮即重置 */
  progress: 0,       /* 已推到的节点数 */
  flows: {},         /* ketto -> 展开状态（跨重渲染保留） */
  trapRemoved: null, /* 陷阱结算结果（进入 trapNode 时算一次） */
  ifHits: [],        /* 本局触发的 IF 事件 */
  seenTrap: false,
  seenIf: false,     /* IF 事件卡是否已确认（确认前总分不定格） */
  pendingIf: false
};

let lastFx = {};     /* 只给「这一帧真的变了的部件」补 .into，避免整棵子树重播动画 */

/* ---------------------------------------------------------------- 工具 */

const $ = id => document.getElementById(id);
/* 空值闸：字段缺失一律落「—」—— 保证 undefined / NaN 永不漏到界面上 */
const fmt = n => (n === null || n === undefined || Number.isNaN(Number(n))) ? '—' : Number(n).toLocaleString('en-US');
const esc = s => (s === null || s === undefined) ? '—'
  : String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (a, b) => (b ? (a / b * 100) : 0);

function shuffle(a) {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
  return b;
}
function fmtPrice(y) {
  if (y >= 1e8) { const v = +(y / 1e8).toFixed(3); return String(v).replace(/\.?0+$/, '') + '億'; }
  return String(Math.round(y / 1e4)) + '万';
}
function dstr(d) { const s = String(d); return s.slice(0, 4) + '.' + s.slice(4, 6) + '.' + s.slice(6, 8); }
function raceMark(x) {
  if (x.f >= 1) {
    if (x.f === 1) return { txt: '1着', cls: 'win' };
    return { txt: x.f + '着', cls: x.f <= 3 ? '' : 'out' };
  }
  const nf = x.nf || 0;
  if (nf === 4 || nf === 5 || nf === 6) return { txt: NF[nf], cls: 'out' };
  return { txt: NF[nf] || '—', cls: 'out' };
}
const countSex = () => {
  let m = 0, f = 0;
  state.roster.forEach(k => { const c = byKet(k); if (c && c.sex === 'M') m++; else f++; });
  return { m, f };
};
/* 未揭晓期的马匹指称（§5.1）：真名未定前一律「？？の〈出生年〉」 */
const designation = () => '？？の' + state.season;
const isFull = () => state.roster.length >= MAX;
const isDone = () => state.progress >= paceLen();

/* ------------------------------------------------------------ 存档 */

function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      v: 1, ts: Date.now(),
      season: state.season, pace: state.pace, mode: state.mode,
      roster: state.roster, batch: state.batch, seen: state.seen, refreshes: state.refreshes,
      pick: state.pick, pickOpen: state.pickOpen,
      progress: state.progress, flows: state.flows,
      /* 【2026-09-14】补上原先漏掉的两个字段，它们各自对应一处「续档后算错 / 玩不下去」：
         ① trapRemoved 缺 ⇒ 在节点 2 之后再续档，被那一刀移除的马复活：重新计入总分、
            结算页「被移除 0 匹」、陷阱 chip 消失；
         ② pendingIf 缺 ⇒ 终局事件卡还开着就续档，恢复后 seenIf 停在 false，而卡片不会自己回来，
            总分永远停在「待定格」—— §4.3 的定格时机再也到不了。 */
      trapRemoved: state.trapRemoved, ifHits: state.ifHits,
      seenTrap: state.seenTrap, seenIf: state.seenIf, pendingIf: state.pendingIf
    }));
  } catch (e) { /* 隐私模式下 localStorage 可能不可写，静默降级 */ }
}
function loadSave() {
  try { const s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); return s && s.v === 1 ? s : null; }
  catch (e) { return null; }
}
const hasSave = () => !!loadSave();

/* -------------------------------------------------------------- 弹窗 */

function openModal(title, html) {
  $('mTitle').textContent = title;
  $('mBody').innerHTML = html;
  $('modal').classList.add('on');
}
function closeModal() {
  $('modal').classList.remove('on');
  /* IF 事件卡「先于总分定格爆发」：卡片关掉这一刻总分才算数（§4.3 节点 3） */
  if (state.pendingIf) {
    state.pendingIf = false;
    state.seenIf = true;
    if (state.screen === 'season') render({ table: true });
  }
}

/* ------------------------------------------------------------ 顶栏 */

function renderTop() {
  const st = { title: 1, draft: 2, season: 3, result: 4 }[state.screen] || 1;
  $('topSteps').innerHTML = [1, 2, 3, 4].map(i => '<i class="' + (i <= st ? 'on' : '') + '"></i>').join('');
  const bits = ['Lite'];
  if (state.season && SV[state.season]) bits.push(meta().label + ' 届');
  if (state.pace) bits.push(state.pace === 'half' ? '半年档' : '季度档');
  if (state.screen === 'season' || state.screen === 'result') bits.push('第 ' + state.progress + ' / ' + paceLen() + ' 次结算');
  if (state.screen === 'draft') bits.push('名单 ' + state.roster.length + ' / ' + MAX);
  $('topMeta').innerHTML = bits.map(esc).join(' <b>·</b> ');
}

/* -------------------------------------------------------- 场景 1 · 标题页 */

const PACE_CARD = {
  half: { n: '半年', d: '2 岁后半 / 德比赛后 / 3 岁收官' },
  quarter: { n: '季度', d: '2 岁秋 / 2 岁冬 / 3 岁春 / 3 岁夏 / 3 岁秋 / 3 岁冬' }
};

function viewTitle() {
  const list = DB.manifest.seasons;
  if (!state.season) state.season = list[0].id;
  const cur = list.find(s => s.id === state.season) || list[0];

  const opts = list.map(s =>
    '<option value="' + s.id + '"' + (s.id === state.season ? ' selected' : '') + '>' +
    '第 ' + s.label + ' 届（' + s.id + ' 年生）</option>').join('');

  const pcard = id => {
    const on = state.pace === id;
    return '<button class="mcard" data-pace="' + id + '" aria-pressed="' + on + '">' +
      '<span class="mn">' + PACE_CARD[id].n + '</span>' +
      '<span class="md">' + PACE_CARD[id].d + '</span>' +
      (on ? '<span class="badge hot">✓ 已选</span>' : '') + '</button>';
  };

  const save = loadSave();
  let savetxt = '';
  if (save) {
    const sp = save.pace === 'half' ? '半年档' : '季度档';
    savetxt = '<div class="sidenote">存档：「' + save.season + ' 届 · ' + sp + ' · 名单 ' +
      (save.roster || []).length + ' / 10 · 第 ' + (save.progress || 0) + ' 次结算」</div>';
  }

  return '' +
    '<section class="screen on' + (lastFx.page ? ' into' : '') + '">' +
    '<div class="hero">' +
    '<div class="kicker">P R E D I C T ・ S E L E C T ・ W I T N E S S</div>' +
    '<h1>ZOG 传奇模式</h1>' +
    '<p>🎵如果有一天，我回到从前<br>' +
    '回到最原始的我，你是否会觉得我不错🎵</p>' +
    '</div>' +

    '<div class="lbl" style="margin-bottom:8px">① 选择模式</div>' +
    '<div class="modebar">' +
    '<button class="mcard" data-mode="lite" aria-pressed="' + (state.mode === 'lite') + '">' +
    '<span class="mn">Lite</span>' +
    '<span class="md">简单规则</span>' +
    '<span class="badge hot">✓ 已选</span></button>' +
    '<button class="mcard off" disabled><span class="mn">Pro</span>' +
    '<span class="md">进阶规则 · 配比可调</span><span class="badge">未开放</span></button>' +
    '</div>' +

    '<div class="lbl" style="margin-bottom:8px">② 选择届次</div>' +
    '<div class="selrow">' +
    '<select class="sel" id="selSeason" aria-label="选择届次">' + opts + '</select>' +
    '<span class="selmeta">成绩窗口 <b class="num">' + esc(cur.label) + '</b>　·　' +
    '名单 <b>10 匹（5 牡 5 牝）</b></span>' +
    '</div>' +

    '<div class="lbl" style="margin-bottom:8px">③ 选择推进节奏</div>' +
    '<div class="modebar">' + pcard('half') + pcard('quarter') + '</div>' +

    '<div class="titleacts">' +
    '<button class="btn" data-start="1"' + (state.pace ? '' : ' disabled') + '>开始选马</button>' +
    '<button class="btn ghost" id="btnContinue"' + (save ? '' : ' disabled') + '>继续存档</button>' +
    '</div>' + savetxt +
    '</section>';
}

/* -------------------------------------------------------- 场景 2 · 选马页 */

/* 保底层：全届（全窗）赏金排名，按届缓存到 SV[id]。a ＝ 前 30 名；b ＝ 第 31~100 名。 */
function guardLayers() {
  const s = S();
  if (!s.guardLayers) {
    const cut = lastCut();
    const order = s.pool.map(c => [c.ketto, cum(c.ketto, cut).score])
      .sort((x, y) => y[1] - x[1]).map(r => r[0]);      /* 先取分再排，避免比较器里重算 6 段 */
    s.guardLayers = { a: order.slice(0, GUARD.upRank), b: order.slice(GUARD.lo - 1, GUARD.hi) };
  }
  return s.guardLayers;
}

/* 抽一个保底槽：默认从第 31~100 名里随机，UP_P 概率升格为前 30。无状态、每批独立。 */
function guardSlot() {
  const L = guardLayers();
  const pool = Math.random() < GUARD.upP ? L.a : L.b;
  return pool[Math.floor(Math.random() * pool.length)];
}

function sampleBatch() {
  const used = new Set(state.roster), cur = new Set(state.batch);
  const cand = S().pool.filter(c => !used.has(c.ketto) && !cur.has(c.ketto));
  const rest = shuffle(cand).slice(0, MAX - 1).map(c => c.ketto);
  let g = null;                                        /* 保底槽：撞上已抽到的（罕见）就重掷 */
  for (let i = 0; i < 30 && !g; i++) {
    const t = guardSlot();
    if (!used.has(t) && rest.indexOf(t) < 0) g = t;
  }
  if (g) rest.splice(Math.floor(Math.random() * (rest.length + 1)), 0, g);   /* 位置随机 */
  rest.forEach(k => { state.seen[k] = 1; });        /* 见过即记：供「错过的马」复盘 */
  return rest;
}

function candCard(ketto, i) {
  const c = byKet(ketto), sel = state.pick === ketto;
  const cross = (c.cross || []).map(([idx, pos]) =>
    '<span class="badge gold">' + esc(D().cross[idx]) + ' ' + esc(pos) + '</span>').join('');
  const tag = damTagOf(c);
  const badges = (tag || cross)
    ? '<div class="badges">' + (tag ? '<span class="badge hot">' + esc(tag) + '</span>' : '') + cross + '</div>'
    : '';

  const own = ownVisible(c, 0), sta = stabVisible(c, 0);
  /* 【2026-09-13 候选卡改「横排成对」】照线上参照版 banushi-game 的 .horse-card-meta：
     每组字段写成「标签：值」的内联对（父：<b>…</b>），由 .kvs 的换行栅格负责折行 ——
     取代旧稿「固定 40px 标签列 ＋ 每项独占一行」（6 字段＝6 行，360px 屏上光标签列
     就白扔 48px/行）。字段集与披露口径一字未动，只换排布：短字段能两个并排，长字段独占一行。 */
  const kv = (label, val, cls) => '<span class="kv"><span class="k">' + label + '：</span>' +
    '<span class="v' + (cls ? ' ' + cls : '') + '">' + val + '</span></span>';

  /* 毛色与性别同行（2026-09-13 用户裁定，回到原型口径）：毛色是纯「看相」项，
     不值得独占一个 KV 行；空值时连分隔符一并省掉，免得留下悬空的「·」。
     注：名单行（rosterList 的 .msb）现同样是「牡 2 歳 · 鹿毛」，两处口径由此统一。 */
  const keiro = keiroOf(c);

  let kvs = kv('父', esc(sireOf(c)));
  kvs += kv('母父', esc(damSireOf(c)));
  kvs += kv('生産', esc(breederOf(c)));
  /* 落札只出「身价」（2026-09-13 用户裁定）：拍卖会名等信息不展示 */
  if (c.price) kvs += kv('落札', fmtPrice(c.price[1]), 'price');
  /* 未揭晓 ⇒ 一律「？？」；即便 stable=-1（源库无厩舍＝从未出赛）也不落「—」，否则等于泄底 */
  kvs += kv('馬主', own ? esc(ownerOf(c)) : '？？', own ? '' : 'hide');
  kvs += kv('厩舎', sta ? esc(stableOf(c)) : '？？', sta ? '' : 'hide');

  /* 选中态只剩「描边 ＋ 右上角对钩」（.cand.sel）：确认动作搬进弹窗的吸底条
     （2026-09-13 用户口径）——「卡下浮出的确认条」随候选区收进弹窗后不再需要，
     且确认键一个就够，取消靠「再点同一张卡」或关窗。 */
  return '<button class="cand' + (sel ? ' sel' : '') + (lastFx.pool ? ' into' : '') +
    '" data-pick="' + esc(ketto) + '" style="animation-delay:' + (i * 30) + 'ms">' +
    '<div class="top"><span class="dname">' + designation() + '</span>' +
    '<span class="sex"><b>' + (c.sex === 'M' ? '牡' : '牝') + '</b> 2 歳' +
    (keiro ? ' · ' + esc(keiro) : '') + '</span></div>' +
    '<div class="kvs">' + kvs + '</div>' + badges +
    '</button>';
}

/* 【已停用 · 2026-09-13】档位徽章 tierOf / tierTag：原「我的牧场・名单档案」用它标「档 N」，
   该弹窗已按用户要求撤下；保留函数备日后复用（候选卡与明细表本来就不给档位）。 */
/* 生産牧場档位：池内字段 breederTier（1 / 2 / 3）；异常值一律落档 3 */
const tierOf = c => (c.breederTier >= 1 && c.breederTier <= 3) ? c.breederTier : 3;
const tierTag = t => '<span class="tier t' + t + '" title="档 ' + t +
  '（档 1 ＝ ノーザンファーム；档 2 ＝ 社台ファーム・社台コーポレーション白老ファーム・社台牧場；其余 ＝ 档 3）">档 ' + t + '</span>';

/* 名单的行式呈现（2026-09-13 用户口径「名单主区 ＋ 候选弹窗 ＋ 空位入口」）：
   10 行常驻铺开、空位也照铺 —— 选到第几轮、还差几匹一眼可见，不用去数。
   抽取入口**长在下一个空位上**：要填的格子本身就是按钮（见 .slotbtn）。
   只有紧接着的那个空位可点 —— 其余空位仍写「待第 N 轮抽取」，
   于是点击位置与填入位置永远同一格，不会出现「点了第 07 格却填进 04」。
   旧版「候选铺满主区 ＋ 名单缩在 300px 侧栏十宫格」整体撤下（样式留档，见 styles.css 末尾）。 */
function rosterList() {
  const rows = [];
  for (let i = 0; i < MAX; i++) {
    const ket = state.roster[i], c = ket ? byKet(ket) : null;
    const no = String(i + 1).padStart(2, '0');
    if (c) {
      rows.push('<div class="mrow filled' + (i === state.roster.length - 1 && lastFx.slot ? ' pop' : '') + '">' +
        '<span class="mno">' + no + '</span>' +
        '<span class="mnm">' + designation() + '</span>' +
        '<span class="msb">' + (c.sex === 'M' ? '牡' : '牝') + ' 2 歳 · ' + esc(keiroOf(c)) + '</span>' +
        '<span class="mped">父 ' + esc(sireOf(c)) + ' · 生産 ' + esc(breederOf(c)) + '</span>' +
        '<span class="mpr">' + (c.price ? fmtPrice(c.price[1]) : '—') + '</span>' +
        '</div>');
    } else if (i === state.roster.length) {
      rows.push('<button class="mrow slotbtn" data-openslot="1">' +
        '<span class="mno">' + no + '</span>' +
        '<span class="plus">+</span>' +
        '<span class="msb">点击抽取本轮候选 · 10 选 1</span>' +
        '<span class="mpr">本轮 ' + state.refreshes + ' 次换池</span>' +
        '</button>');
    } else {
      rows.push('<div class="mrow"><span class="mno">' + no + '</span>' +
        '<span class="msb">空位 · 待第 ' + (i + 1) + ' 轮抽取</span></div>');
    }
  }
  return '<div class="mylist">' + rows.join('') + '</div>';
}

/* 候选条上的「已选几牡几牝 / 还需几匹」（2026-09-13 用户口径）：
   约束自检栏（旧版常驻在名单侧栏）撤下后，这两个最容易记错的计数改成**每次抽候选给一次** ——
   一屏 10 选 1 的当下正是唯一需要它们的时刻，关窗即随之消失，不占常驻版面。
   只报计数与「还需几匹」，不做判定 —— 5 牡 5 牝这条线由玩家自己盯（与撤下自检栏同一口径）。 */
function sexTally() {
  const { m, f } = countSex();
  const cls = v => v === 5 ? 'ok' : (v > 5 ? 'ng' : '');   /* 刚好 5 匹转绿，超了转红 */
  /* 【2026-09-13 窄屏】原版整串在 360px 屏上折成两行，把整条候选条顶到 2~3 行高、
     白吃掉卡片的地。窄屏只留「牡 x/5 · 牝 y/5」——「还需几匹」由 5−x 直接读得，
     「名单 n/10」主区那 10 行本就常驻，不差这一处复述。
     两版同一个数据源（countSex），只是宽版多挂两个 .wideonly 片段，不会走样。 */
  return '<span class="wideonly">名单 ' + state.roster.length + ' / ' + MAX + ' <span>·</span> </span>' +
    '牡 <b class="' + cls(m) + '">' + m + '</b> / 5' +
    ' <span>·</span> 牝 <b class="' + cls(f) + '">' + f + '</b> / 5' +
    '<span class="wideonly"> <span>·</span> 还需 牡 ' + Math.max(0, 5 - m) +
    ' · 牝 ' + Math.max(0, 5 - f) + '</span>';
}

/* 开一轮（2026-09-13 用户口径：每轮 3 次、换轮重置）＝ 抽一批候选 ＋ 把**本轮**的换池次数回满。
   必须与「本轮内整批换池」分开：换池那一次只调 sampleBatch()，**不能**回满次数 ——
   否则换池永远用不完（这正是一开始把次数记成整局共用的原因，现在改用「每轮重置」记法）。
   调用点三处：确认入名单后开下一轮 / 进选马页兜底 / 点空位兜底。 */
function startRound() {
  state.batch = sampleBatch();       /* 保底槽在 sampleBatch 里逐批掷（见 GUARD），无跨轮状态 */
  state.refreshes = REFRESH_PER_ROUND;
}

/* 抽取弹窗：一轮 ＝ 抽一批 10 条候选 → 可整批换池 3 次 → 确认 1 匹 → 下一轮（次数随轮重置）。
   弹窗节点放在 #app 之外（见 index.html 的 #pickModal）：选卡 / 换池都会触发 #app 整树重绘，
   挂在外面的弹窗才不会被冲掉。需要跟着 state 变的两处：主体由 renderPick() 重绘，
   吸底动作条是静态节点、只改文案与 disabled（重建会让正要按的按钮跳位）。 */
function openPick() {
  if (isFull()) return;
  if (!state.batch.length) startRound();   /* 兜底：直进选马页时批次为空 ＝ 这一轮还没开 */
  state.pickOpen = true;
  state.pick = null;
  render({ pool: true });                                 /* 首开＝一批新卡：播一次错峰入场 */
  const sheet = document.querySelector('#pickModal .sheet');
  if (sheet) sheet.scrollTop = 0;                         /* 新开窗从顶部看起，不继承上次滚动位置 */
}
function closePick() {
  state.pickOpen = false;
  state.pick = null;               /* 关窗即放弃未确认的选中（换池次数不返还） */
  render({});
}

/* 弹窗主体：本轮 10 条候选 ＋ 整批换池。卡片沿用 .cand / .candgrid（与旧版候选区同一套样式）。 */
function pickBody() {
  return '<div class="pkbar">' +
    '<span class="lbl">本轮候选 · ' + state.batch.length + ' 选 1 · 第 ' + (state.roster.length + 1) + ' 轮</span>' +
    '<span class="pkneed">' + sexTally() + '</span>' +
    '<button class="btn ghost" data-refresh="1"' + (state.refreshes <= 0 ? ' disabled' : '') + '>' +
    /* 窄屏给短写：完整文案在 360px 屏上会把候选条再撑出一行（2026-09-13 实测）。 */
    '<span class="wideonly">整批换池（本轮剩余 ×' + state.refreshes + '）</span>' +
    '<span class="narrowonly">换池 ×' + state.refreshes + '</span>' +
    '</button>' +
    '</div>' +
    '<div class="candgrid" id="candGrid">' + state.batch.map(candCard).join('') + '</div>' +
    /* 【2026-09-13 窄屏实测】原文 5 行、在手机上吃掉大半屏，一屏只剩 1~2 张卡。
       弹窗里只留「怎么点」，规则细节（换池次数、已入名单不再出现、关窗不返还等）
       一律搬进 rulesHtml() 的「抽取与换池」一节 —— 需要时点「规则说明」看。
       现文再砍到 2 行，为候选卡让出约 17px。 */
    '<div class="sidenote">点卡片＝<b>选中</b>（再点取消）→ 底部「确认加入名单」；' +
    '换池＝<b>整批</b>换 10 条；卡上不标档位，须自行判断。</div>';
}

/* 待还原的滚动位置：renderPick() 只**记**不写，真正写回由 render() 末尾的 restorePickScroll()
   在 syncCandHeights() 之后执行（原因见该函数注释）。 */
let pickScrollKeep = null;

/* 弹窗重绘：主体整块换掉（顺带保留滚动位置），吸底动作条只改文案与可用性。
   滚动位置必须手工还原 —— 选卡会触发一次整屏 render，innerHTML 一换滚动就回顶，
   玩家点了靠下那张卡却被迫重新找位置。滚动容器是 .sheet（它有 max-height + overflow）。
   未开窗时把主体清空：旧内容留在 DOM 里会让 syncCandHeights() 量到一批隐藏的卡。 */
function renderPick() {
  const pm = $('pickModal'), body = $('pkBody');
  if (!pm || !body) return;
  if (!state.pickOpen || state.screen !== 'draft') {
    pm.classList.remove('on');
    if (body.innerHTML) body.innerHTML = '';
    return;
  }
  $('pkTitle').textContent = '第 ' + (state.roster.length + 1) + ' 轮 · 抽取候选';
  const sheet = pm.querySelector('.sheet');
  pickScrollKeep = sheet ? sheet.scrollTop : null;
  body.innerHTML = pickBody();

  const c = state.pick ? byKet(state.pick) : null;
  /* 动作条只有「确认」一个键（2026-09-13 用户口径：取消键多余，与原型一致）。
     撤选的出口本来就有两个，且都比一个按钮更省事：
     ① 再点同一张卡 ＝ 取消该卡（选卡是开关）；② 关窗（× 或点遮罩）＝ 连同未确认的选中一起放弃。 */
  /* 【2026-09-13 窄屏实测】吸底条这段文案原本 60+ 字，在 360px 屏上折成 4~5 行，
     把「确认加入名单」整颗挤到第二行 —— 既是按不到的原因之一，也白吃掉一屏卡片。
     现在只留「确认是哪一匹」这一件事（生産/毛色等卡上本就有）。
     【同日再删 4 字「（再点取消）」】候选区下方的 .sidenote 已经写明
     「点卡片＝选中（再点取消）」，这里是重复；更关键的是 360px 屏上 .pkpick
     仅剩约 198px 宽，带上它之后碰上 11 字的长父名（如 ブリックスアンドモルタル）
     会折到第 3 行、高 54px —— 高过确认键的约 40px，吸底条于选中/取消之间
     在 55px 与 67px 之间来回撑，正是用户反馈的「卡片跳来跳去」。
     删掉后最长父名也稳在两行，配合 styles.css 窄屏 .pkpick 的固定两行高，不再参与布局。 */
  $('pkPick').innerHTML = c
    ? '已选中 <b>' + designation() + '</b> · ' + (c.sex === 'M' ? '牡' : '牝') + ' 2 歳 · 父 ' +
      esc(sireOf(c))
    : '点卡片<b>选中</b>一匹，再点底部「确认加入名单」才计入';
  $('btnConfirm').disabled = !c;
  pm.classList.add('on');
}

function viewDraft() {
  const full = isFull();
  const round = state.roster.length + 1;

  /* 抽取是一次**显式动作**：进选马页只预抽一批、不自动开窗，必须点那一下空位。
     名单满员后不再给抽取入口 —— 没有空位＝没得点，比「按钮消失 ＋ 文案解释已关闭」自然。 */
  const head = full
    ? '<div class="shead"><h2>名单已满 · ' + MAX + ' / ' + MAX + '</h2>' +
      '<p>空位已用尽，抽取自然关闭。确认下方名单后点「锁定开赛 →」进入推演。' +
      '<button class="rules-link" data-rules="1" style="margin-left:8px">规则说明</button></p></div>'
    : '<div class="shead"><h2>选马 · 第 ' + round + ' 轮</h2>' +
      /* 【2026-09-13】原文 100+ 字，手机上一段就占掉 5 行。这里只留「怎么操作 ＋ 本轮还剩几次换池」，
         换池与入名单的规则细节收进「规则说明」（rulesHtml 的「抽取与换池」一节）。 */
      '<p>点名单里的<b>空位</b>抽本轮 <b>10 条候选</b> → 点卡片选中 → 「确认加入名单」。' +
      '每轮可<b>整批换池 ' + REFRESH_PER_ROUND + ' 次</b>（本轮剩余 ×' + state.refreshes + '）。' +
      '<button class="rules-link" data-rules="1" style="margin-left:8px">规则说明</button></p></div>';

  /* 动作行只剩「锁定开赛」一件事（2026-09-13 用户口径）：
     抽取入口搬到名单里的空位上（见 rosterList 的 .slotbtn），这里不再重复摆一个「抽候选」按钮 ——
     同一件事有两个按钮，玩家还得判断它们的先后。未满员时此键置灰，预告终点在哪、不必翻去找。 */
  const act = '<div class="pickact">' +
    '<button class="btn" data-lock="1"' + (full ? '' : ' disabled') + '>' +
    (full ? '锁定开赛 →' : '选满 ' + MAX + ' 匹后锁定') + '</button>' +
    '<span class="note">' + (full
      ? '名额已满 ' + MAX + ' / ' + MAX + ' —— 空位用尽，抽取自然关闭'
      : '选满 ' + MAX + ' 匹后此键解锁') + '</span>' +
    '</div>';

  return '' +
    '<section class="screen on' + (lastFx.page ? ' into' : '') + '">' +
    head +
    '<div class="lbl" style="margin-bottom:8px">我的名单 · ' + state.roster.length + ' / ' + MAX + '</div>' +
    rosterList() +
    '<div style="margin-top:12px">' + act + '</div>' +
    '</section>';
}

/* -------------------------------------------------------- 场景 3 · 推演页 */

const SCORE_HEAD = () => state.progress === 0 ? 'ZOG 分'
  : (state.progress <= trapNode() ? '2 岁 ZOG 分' : '累计 ZOG 分');

const SCORE_TIP = '截至当前切点的累计：分数 ＝ 窗口内有赏金场次的 本賞金(万円) 之和；' +
  '1 万円 ＝ 1 分（100 万円 ＝ 100 分）、无系数。Lite 只认前 5 名。';

function rowsForSeason() {
  const k = state.progress;
  let arr = state.roster.map(ket => ({ ket, c: byKet(ket) }));
  const removed = new Set((state.trapRemoved || []).map(r => r.ketto));
  if (k === 0) return arr;                                  /* 未结算：按选取顺序，不预排序 */
  const cut = cutOf(k);
  arr.sort((a, b) => {
    const ga = removed.has(a.ket) ? 1 : 0, gb = removed.has(b.ket) ? 1 : 0;
    if (ga !== gb) return ga - gb;                          /* 被移除者恒沉底 */
    return scoreAt(b.ket, cut) - scoreAt(a.ket, cut);
  });
  return arr;
}

function pedCell(c, k) {
  const mother = (k >= nameNode()) ? esc(c.dam) : '？？';
  return '父 ' + esc(sireOf(c)) + '<br><span class="' + (k >= nameNode() ? '' : 'hide') + '">母 ' + mother + '</span>';
}

function flowRow(ket, colspan) {
  const cut = state.progress ? cutOf(state.progress) : cut0();
  let rows = traceOf(ket, cut);
  let delta = '';
  const isIf = state.ifHits.some(h => h.hero === ket) && state.progress >= paceLen() && state.seenIf;
  if (isIf) { const r = ifResult(ket); rows = r.rows; delta = r.delta; }

  if (!rows.length) return '<tr class="frow' + (lastFx.flow === ket ? ' into' : '') + '"><td colspan="' + colspan + '"><div class="racemore">该马在截至本节点的窗口内没有出赛记录。</div></td></tr>';

  const html = rows.map(x => {
    const mk = raceMark(x);
    const g = GRADE[x.g] || '';
    const jk = x.j >= 0 ? (D().jockey[x.j] || '—') : '—';
    return '<div class="race">' +
      '<span class="rd">' + dstr(x.d) + '</span>' +
      '<span class="rn">' + esc(x.r) + (g ? '（' + g + '）' : '') + '</span>' +
      '<span class="rj">' + esc(jk) + '</span>' +
      '<span class="rr ' + mk.cls + '">' + mk.txt + '</span>' +
      '<span class="rp">' + (x.p ? fmt(x.p) + '万' : '—') + '</span>' +
      '</div>';
  }).join('');

  const note = isIf
    ? '<div class="racemore">✦ 本行含<b>世界线变动</b>后的赛果（赏金 ' + (delta >= 0 ? '＋' : '−') + fmt(Math.abs(delta)) + ' 万）</div>'
    : '';
  return '<tr class="frow' + (state.flows[ket] ? ' open' : '') + (lastFx.flow === ket ? ' into' : '') + '"><td colspan="' + colspan + '">' + html + note + '</td></tr>';
}
function cut0() { return meta().cuts[0]; }

function simTable() {
  const k = state.progress, cut = k ? cutOf(k) : cut0();
  const arr = rowsForSeason();
  const removed = new Set((state.trapRemoved || []).map(r => r.ketto));
  const showStab = arr.some(r => stabVisible(r.c, k));
  const showOwn = arr.some(r => ownVisible(r.c, k));

  let cols = 6 + (showStab ? 1 : 0) + (showOwn ? 1 : 0);
  const canFlow = k >= nameNode();

  const head = '<tr><th class="c-no" title="纯行号（1–10），非血统番号">No</th>' +
    '<th>马名</th><th>性齢</th><th title="1着-2着-3着-着外；0 场显示 —">成績</th>' +
    '<th>血統</th>' +
    (showStab ? '<th class="c-stab" title="初厩（入厩当时的厩舎，不随后续転厩变化）">厩舎</th>' : '') +
    (showOwn ? '<th class="c-own">馬主</th>' : '') +
    '<th class="c-score" title="' + esc(SCORE_TIP) + '" style="text-align:right">' + SCORE_HEAD() + '</th></tr>';

  const body = arr.map((r, i) => {
    const c = r.c, gone = removed.has(r.ket);
    const revealed = k >= nameNode();
    const name = revealed
      ? esc(c.name) + (gone ? '<span class="voidnote">不计分 · 被规则移除</span>' : '')
      : designation() + (gone ? '<span class="voidnote">已被移除 · 身份不揭晓</span>' : '');
    /* 【2026-09-13】明细表的性齢列不再带「歳」：表头已写「性齢」，单元格里「牡 3」即够。
       候选卡与名单行（"牡 2 歳 · 鹿毛"）不在此列 —— 那里没有表头，单位留着才读得懂。 */
    const age = String(k > trapNode() ? 3 : 2);
    const sc = gone ? '—' : scoreAt(r.ket, cut);
    const rec = gone ? '—' : recAt(r.ket, cut);
    const open = !!state.flows[r.ket];
    return '<tr class="mrow' + (open ? ' open' : '') + (gone ? ' void' : '') + ' drop' + (lastFx.table ? ' into' : '') +
      '" data-rows="' + (canFlow && !gone ? esc(r.ket) : '') + '">' +
      '<td class="c-no">' + (canFlow && !gone ? '<span class="caret">▶</span>' : '') + (i + 1) + '</td>' +
      '<td class="c-name">' + name + '</td>' +
      '<td class="c-age">' + (c.sex === 'M' ? '牡' : '牝') + ' ' + age + '</td>' +
      '<td class="rec">' + rec + '</td>' +
      '<td class="c-ped">' + pedCell(c, k) + '</td>' +
      (showStab ? '<td class="c-stab">' + stabCell(c, k) + '</td>' : '') +
      (showOwn ? '<td class="c-own">' + ownCell(c, k) + '</td>' : '') +
      '<td class="c-score">' + (typeof sc === 'number' ? fmt(sc) : sc) + '</td>' +
      '</tr>' +
      (canFlow && !gone ? flowRow(r.ket, cols) : '');
  }).join('');

  const live = arr.filter(r => !removed.has(r.ket));
  const sum = k === 0 ? null : live.reduce((a, r) => a + scoreAt(r.ket, cut), 0);
  const frozen = k >= paceLen() && state.seenIf;
  const foot = '<tr><td colspan="' + (cols - 1) + '" style="text-align:right">' +
    (k === 0 ? '未结算' : (frozen ? '玩家总分（含 IF 变动）' : (k >= paceLen() ? '玩家总分（待 IF 事件卡关闭后定格）' : '玩家总分'))) +
    '</td><td class="c-sum' + (k === 0 ? ' pend' : '') + '">' + (sum === null ? '—' : fmt(sum)) + '</td></tr>';

  return '<div class="tw"><table class="rows"><thead>' + head + '</thead><tbody>' + body + '</tbody><tfoot>' + foot + '</tfoot></table>' +
    (canFlow ? '' : '<div class="tw-hint">节点 ' + nameNode() + ' 起可展开逐场轨迹</div>') + '</div>';
}

function simTimeline() {
  const meta_ = NODE_META[state.pace], nc = nodeCuts();
  return nc.map((d, i) => {
    const k = i + 1, on = k <= state.progress, cur = k === state.progress;
    const from = i === 0 ? (state.season + 2) + '.6 开赛' : nc[i - 1] + ' 之后';
    return '<div class="tl' + (on ? ' on' : '') + (cur ? ' cur' : '') + '">' +
      '<div class="tk">' + meta_[i].t + (cur ? ' · 已结算' : '') + '</div>' +
      '<h4>' + meta_[i].k + '</h4>' +
      '<p>' + from + ' → ' + d + '</p>' +
      '<p>' + meta_[i].d + '</p></div>';
  }).join('');
}

function simChips() {
  const t = trapNode(), out = [];
  /* 「错过的名马」入口（2026-09-13，替换掉撤下的「我的牧场・名单档案」）：
     只在**真名揭晓后**（节点 2 起）出现 —— 之前列出来全是「？？」，玩家认不得（用户指出）。
     逐场数据也是节点 2 起才加载，判定「赢过重赏」正好同一时点可用。 */
  if (state.progress >= nameNode()) {
    out.push('<button class="evchip" data-evmiss="1">错过的名马</button>');
  }
  if (state.progress >= t) {
    const n = (state.trapRemoved || []).length;
    out.push('<button class="evchip bad" data-evtrap="1">⚠ 规则陷阱 · 移除 ' + n + ' 匹</button>');
  }
  if (state.progress >= paceLen()) {
    const n = state.ifHits.length;
    out.push('<button class="evchip' + (n ? ' gold' : '') + '" data-evif="1">✦ IF 世界线 · ' + n + ' 处变动</button>');
  }
  return out.join('');
}

function viewSeason() {
  const k = state.progress, done = k >= paceLen();
  const nextBtn = done
    ? '<button class="btn" data-result="1">查看结算 →</button>'
    : '<button class="btn" data-advance="1">继续模拟（到 ' + cutOf(k + 1) + '）</button>';

  return '' +
    '<section class="screen on' + (lastFx.page ? ' into' : '') + '">' +
    '<div class="shead"><h2>推演 · ' + meta().label + ' 届（' + (state.pace === 'half' ? '半年' : '季度') + '档）</h2>' +
    '<p>整局共 <b>' + paceLen() + '</b> 次结算，当前已推进 <b>' + k + '</b> 次。</p></div>' +
    '<div class="timeline' + (paceLen() === 6 ? ' p6' : '') + '">' + simTimeline() + '</div>' +
    '<div class="panel">' +
    '<div class="hd"><b>名单明细</b><span>' + simStatus() + '</span></div>' +
    simTable() +
    '<div class="sidenote" style="padding:10px 12px;margin:0;border-top:1px solid var(--line)">' + simNote() + '</div>' +
    '</div>' +
    '<div class="simfoot"><div class="evs">' + simChips() + '</div><div class="acts">' + nextBtn + '</div></div>' +
    '</section>';
}

function simStatus() {
  if (state.progress === 0) return '未结算 · 按选取顺序';
  const k = state.progress;
  const head = SCORE_HEAD();
  return '节点 ' + k + ' · ' + (k <= trapNode() ? '2 岁分降序' : '累计分降序') + '（不计分者列在最后）';
}
function simNote() {
  const k = state.progress;
  if (k === 0) return '未结算 —— 所有分数为「—」。按下「继续模拟」推进到第一个结算节点（' + cutOf(1) + '）。';
  const parts = [];
  parts.push(k <= trapNode() ? '当前只有<b>成绩摘要</b>：出赛 n 场 m 胜、最高着顺、本賞金 —— 逐场（赛事名 / 骑手 / 对手）尚未公布。'
    : '点表中任意一行，可就地展开它的<b>逐场</b>（日期 / 赛事名 / 骑手 / 着顺 / 本賞金）。');
  if (k >= trapNode()) parts.push('规则陷阱已在 ' + meta().anchors.trap + ' 结算。');
  if (k >= nameNode()) parts.push('真名已于 ' + meta().anchors.names + ' 揭晓（母名同帧放出）。');
  if (k >= paceLen()) parts.push('终局已到，总分定格。');
  return parts.join(' ');
}

function trapBody() {
  const rs = state.trapRemoved || [];
  const cut = meta().anchors.trap;
  if (!rs.length) {
    return '<p>三类结构约束（性别 / 牧场档位 / 同父产驹）在 ' + esc(cut) + ' 检查后<b>全部合规</b> —— 名单中无马被移除。</p>';
  }
  const blocks = rs.map(r => {
    const c = byKet(r.ketto);
    const s = cum(r.ketto, cut).score;
    return '<div class="voidbox">' +
      '<div class="ck">移除第 ' + r.round + ' 匹</div>' +
      '<h4 style="font-family:var(--head-font);font-size:13.5px;margin:7px 0 5px">' +
      (state.progress >= nameNode() ? esc(c.name) : '？？の' + state.season) + '</h4>' +
      '<p>违反：' + esc(r.sets.join(' ／ ')) + '</p>' +
      '<p>所属违规集合数 <b>' + r.setsCount + '</b>（同集合数中 ZOG 分最高者被移除）　·　' +
      '其 2 岁 ZOG 分 <b class="num">' + fmt(s) + '</b></p>' +
      '<p>该匹仍在表内占一行，但<b>不计入总分</b>，身份留待真名揭晓时一并曝光。</p>' +
      '</div>';
  }).join('');
  return '<p>名单须同时满足三类结构约束，任一不满足即违规；惩罚统一在 ' + esc(cut) + ' 执行，' +
    '每轮从「所属违规集合数最多」的马中移除 ZOG 分最高者，直到合规。</p>' + blocks;
}

function ifBody() {
  const evs = state.ifHits;
  if (!evs.length) return '<p><b>这一届风平浪静</b> —— 名单里的马都按原本的路走了下去。</p>';
  const cards = evs.map(ev => {
    const ops = ev.rewrite.map(op => {
      const nm = op.race[1], d = op.race[0].replace(/-/g, '.');
      /* 【2026-09-13】明细行不再带动作词（原先有「撤出 / 多跑一场 / 着顺变了 / 赏金变了 / 非完走」）。
         这些词和「改写」「变动」是同一类东西 —— 都在替玩家总结"这一行是在干什么"，
         而赛名、着顺、赏金、以及「不再计入」这几个字已经把事实说完了（用户裁定）。
         「その影響」标头本身就是这整块的总起，底下的行只需要陈述。 */
      let shot = '';
      if (op.op === 'set') shot = '第 ' + op.wasFinish + ' 着 → 第 ' + op.finish + ' 着（赏金 ' + fmt(op.wasPrize) + ' → ' + fmt(op.prize) + ' 万）';
      else if (op.op === 'prize') shot = '赏金 ' + fmt(op.wasPrize) + ' → ' + fmt(op.prize) + ' 万（着顺不变）';
      else if (op.op === 'add') shot = '第 ' + op.finish + ' 着（赏金 ' + fmt(op.prize) + ' 万）';
      else if (op.op === 'drop') shot = '原第 ' + op.wasFinish + ' 着（赏金 ' + fmt(op.wasPrize) + ' 万）不再计入';
      else if (op.op === 'nf') shot = '原第 ' + op.wasFinish + ' 着 → ' + NF[op.nf];
      return '<div class="opline"><b>' + d + ' ' + esc(nm) + '</b>　' + shot + '</div>';
    }).join('');
    /* 【2026-09-13】明细与分数收在「その影響」标头下（原先明细归明细、末尾另挂一行「影响分数：有／无」）。
       没有分数时**不写任何东西**：原来的「ZOG 分不变 —— 落在赏金区外，成绩串会变」
       是在向玩家解释"这里为什么没有分数"，而"没有分数"本身不需要解释（用户裁定）。
       有分数时才出现一行 —— 那是玩家真正要拿走的数字。 */
    const score = ev.scoreImpact
      ? '<div class="ifscore hot">✦ 赏金 ' + (ev.delta >= 0 ? '＋' : '−') + fmt(Math.abs(ev.delta)) +
        ' 万（ZOG ' + (ev.delta >= 0 ? '＋' : '−') + fmt(Math.abs(ev.delta)) + ' 分）</div>'
      : '';
    /* 只渲染玩家该看的：马名 ＋ 正文 ＋ 「その影響」块。
       刻意不渲染 trigger.desc（幕后触发设定）与 spill（对其他马的核算记录）——
       两者都是构建期的设计备注，带「（非本届，忽略）」这类内部括注，摊到玩家面前直接出戏（2026-09-13 用户报）。 */
    return '<div class="ifcard"><span class="iftag">IF</span>' +
      '<h4>' + esc(ev.name) + '</h4>' +
      '<p class="hi">' + esc(ev.text) + '</p>' +
      '<div class="ifimpact"><span class="ifimplabel">その影響</span>' + ops + score + '</div>' +
      '</div>';
  }).join('');
  /* 【2026-09-13】原先这里有一段总起：「被点名的名马撬动了历史 —— 改写写进赛果，
     计分读取的就是改写后的新赛果。先看历史被改，再看含改写的分数。」
     它是在替玩家**解说卡片的结构与读法**（先说哪半张、后说哪半张），而不是给出内容本身 ——
     卡片自己已经有 IF 标签、马名、正文与「その影響」块，再讲一遍就成了看说明书（用户报：太出戏）。
     删掉后弹窗一开即见卡片；「改写进赛果、分数读的是新赛果」这个口径移入 rulesHtml 的「IF 世界线」一节。
     注意 ifBody() 同时被结算页内嵌（见 viewResult 的 ifRec），两处的效果一并变干净。 */
  return '<div class="ifstack">' + cards + '</div>';
}

/* 「错过的名马」：本局**见过但没选走**的名马（推演页 / 结算页共用）。
   两处收窄（2026-09-13 用户意见）：① 「名马」＝**截至当前切点的赏金前 30**（＝保底升级槽那一层，
   其余是随机抽到的）—— 全列的话玩家认不得那些「？？の〈年〉」；
   ② 入口只在**真名揭晓后**出现（节点 2 起），之前名字全是「？？」，列了也没意义。
   口径守揭晓规则：一律按**截至当前切点**的赛果判定与排序（分数降序），绝不看窗口外赛果。
   名单里的 10 匹、以及当前还没决定的这批候选都不列入 —— 那些不算「错过」。 */
function missBody() {
  const k = state.progress, cut = k ? cutOf(k) : cut0();
  const revealed = k >= nameNode();
  const inRoster = new Set(state.roster);
  const top = topRankAt(cut);                               /* 「名马」＝ 当前切点的赏金前 30 */
  const miss = Object.keys(state.seen)
    .filter(x => top.has(x) && !inRoster.has(x) && state.batch.indexOf(x) < 0 && byKet(x));
  if (!miss.length) {
    return '<p>本局<b>没有漏掉名马</b> —— 出现过的前 30 名都在你的名单里。</p>';
  }
  const list = miss.map(x => ({ x, c: byKet(x), s: scoreAt(x, cut) }));
  list.sort((a, b) => b.s - a.s);
  const rows = list.map((r, i2) => {
    const c = r.c;
    return '<tr>' +
      '<td class="c-no">' + (i2 + 1) + '</td>' +
      '<td class="c-name">' + (revealed ? esc(c.name) : designation()) + '</td>' +
      '<td class="c-age">' + (c.sex === 'M' ? '牡' : '牝') + ' ' + (k > trapNode() ? 3 : 2) + '</td>' +
      '<td class="c-ped">' + esc(sireOf(c)) + '</td>' +
      '<td class="c-ped">' + esc(breederOf(c)) + '</td>' +
      '<td class="rec">' + recAt(r.x, cut) + '</td>' +
      '<td class="c-score">' + fmt(r.s) + '</td>' +
      '</tr>';
  }).join('');
  const head = '<tr><th class="c-no">No</th><th class="c-name">马名</th><th class="c-age">性齢</th>' +
    '<th>父</th><th>生産牧場</th><th>成績</th>' +
    '<th class="c-score" style="text-align:right">' + SCORE_HEAD() + '</th></tr>';
  return '<p>本局<b>见过但没选走</b>的名马 —— 共 <b>' + list.length + '</b> 匹。' +
    '<div class="tw"><table class="rows"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div>';
}

/* 「当前切点的赏金前 30」集合：按切点缓存到 SV[id]（每届只算一次每个切点）。
   一律用 scoreAt(·, cut) 现算 —— 结算时 cut 即全窗，于是自然等同于「窗口内赏金前 30」。 */
function topRankAt(cut) {
  const s = S();
  s.topCache = s.topCache || {};
  if (!s.topCache[cut]) {
    const arr = s.pool.map(c => c.ketto)
      .map(x => [x, scoreAt(x, cut)])
      .sort((a, b) => b[1] - a[1]).slice(0, GUARD.upRank)
      .map(r => r[0]);
    s.topCache[cut] = new Set(arr);
  }
  return s.topCache[cut];
}

/* 【当前未使用 · 留档备复用】全届名次表（只覆盖保底层的前 100 名）：
   曾用于给「错过的马」标「全届第 N 名」，收窄为「只列名马」后暂时用不上。
   将来若要恢复名次标注，注意**只能在结算页调用** —— 名次本身就是窗口外赛果的另一种说法。 */
function guardRank() {
  const L = guardLayers(), r = {};
  L.a.forEach((x, i2) => { r[x] = i2 + 1; });
  L.b.forEach((x, i2) => { r[x] = GUARD.lo + i2; });
  return r;
}

/* -------------------------------------------------------- 场景 4 · 结算页 */

function viewResult() {
  const k = state.progress, cut = lastCut();
  const removed = new Set((state.trapRemoved || []).map(r => r.ketto));
  const live = state.roster.filter(x => !removed.has(x));
  const total = live.reduce((a, x) => a + scoreAt(x, cut), 0);

  const arr = live.map(x => ({ ket: x, c: byKet(x), s: scoreAt(x, cut) })).sort((a, b) => b.s - a.s);
  const showStab = arr.some(r => stabVisible(r.c, k)), showOwn = arr.some(r => ownVisible(r.c, k));
  /* 列数：名次 / 马名 / 性齢 / 成績 / 血統（5）＋ 厩舎・馬主（条件付き）＋ 贡献 ＋ 分数
     （2026-09-13 修：原式末尾只 +1，漏了「贡献」一列 ⇒ 展开的逐场行 colspan 少 1，右侧空一格）。 */
  const cols = 7 + (showStab ? 1 : 0) + (showOwn ? 1 : 0);

  const head = '<tr><th class="c-no">名次</th>' +
    '<th class="c-name">马名</th><th class="c-age">性齢</th>' +
    '<th>成績</th><th>血統</th>' +
    (showStab ? '<th class="c-stab">厩舎</th>' : '') + (showOwn ? '<th class="c-own">馬主</th>' : '') +
    '<th class="c-share">贡献</th><th class="c-score" style="text-align:right">' + SCORE_HEAD() + '</th></tr>';

  const body = arr.map((r, i) => {
    const open = !!state.flows[r.ket];
    return '<tr class="mrow' + (open ? ' open' : '') + '" data-rows="' + esc(r.ket) + '">' +
      '<td class="c-no">' + (i + 1) + '<span class="caret">▶</span></td>' +
      '<td class="c-name">' + esc(r.c.name) + '</td>' +
      '<td class="c-age">' + (r.c.sex === 'M' ? '牡' : '牝') + ' 3</td>' +
      '<td class="rec">' + recAt(r.ket, cut) + '</td>' +
      '<td class="c-ped">' + pedCell(r.c, k) + '</td>' +
      (showStab ? '<td class="c-stab">' + stabCell(r.c, k) + '</td>' : '') +
      (showOwn ? '<td class="c-own">' + ownCell(r.c, k) + '</td>' : '') +
      '<td class="c-share"><span class="bar' + (i === 0 ? ' g' : '') + '"><i style="width:' + pct(r.s, total).toFixed(1) + '%"></i></span>' +
      '<span class="sub">' + pct(r.s, total).toFixed(1) + '%</span></td>' +
      '<td class="c-score">' + fmt(r.s) + '</td></tr>' +
      flowRow(r.ket, cols);
  }).join('');

  const rm = (state.trapRemoved || []).map(r => {
    const c = byKet(r.ketto);
    return '<div class="cutcard" style="margin-bottom:10px"><div class="ck">那一刀</div>' +
      '<h4>' + esc(c.name) + '</h4>' +
      '<p>违反 <b>' + esc(r.sets.join(' ／ ')) + '</b>　·　' +
      '本可贡献 <b class="num">' + fmt(finalScore(r.ketto)) + '</b>（其全窗 ZOG 分），因规则不计入总分。' +
      '<br>若它在，玩家总分将是 <b class="num">' + fmt(total + finalScore(r.ketto)) + '</b>。</p></div>';
  }).join('');

  const ifRec = state.ifHits.length
    ? '<div class="panel" style="margin-top:16px"><div class="hd"><b>本局 IF 世界线变动</b>' +
      '<span>' + state.ifHits.length + ' 处 · 已计入总分</span></div>' +
      '<div style="padding:12px">' + ifBody() + '</div></div>'
    : '';

  const sum = state.ifHits.reduce((a, e) => a + (e.scoreImpact ? e.delta : 0), 0);

  return '' +
    '<section class="screen on' + (lastFx.page ? ' into' : '') + '">' +
    '<div class="shead"><h2>结算 · ' + meta().label + ' 届</h2>' +
    '<p>成绩窗口 ' + esc(meta().cuts[0]) + ' ～ ' + esc(lastCut()) + '（' +
    (state.pace === 'half' ? '半年' : '季度') + '档 ' + paceLen() + ' 次结算）。</p></div>' +

    '<div class="scorewrap"><div class="scorebig">' + fmt(total) + '</div>' +
    '<div class="scoremeta">玩家总分 · ZOG（1 万円 ＝ 1 分）<br>' +
    '计分马 <b>' + arr.length + '</b> 匹　·　被移除 <b>' + (state.trapRemoved || []).length + '</b> 匹<br>' +
    'IF 变动净增 <b>' + (sum >= 0 ? '＋' : '−') + fmt(Math.abs(sum)) + '</b> 分（' + state.ifHits.length + ' 处）</div></div>' +

    '<div class="rgrid"><div class="panel"><div class="hd"><b>最终明细</b>' +
    '<span>按累计分降序 · 点行展开逐场</span></div>' +
    '<div class="tw"><table class="rows"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div></div>' +
    '<div><div class="rgrid-side">' + rm + '</div></div></div>' +

    ifRec +

    '<div class="acts">' +
    '<button class="btn ghost" data-evmiss="1">错过的名马</button>' +
    '<button class="btn ghost" data-back="1">回到推演页</button>' +
    '<button class="btn" data-restart="1">换届次重开</button>' +
    '</div>' +
    '</section>';
}

/* ---------------------------------------------------------------- 渲染 */

const VIEWS = { title: viewTitle, draft: viewDraft, season: viewSeason, result: viewResult };

function render(fx) {
  lastFx = fx || {};
  renderTop();
  $('app').innerHTML = VIEWS[state.screen]();
  renderPick();                     /* 抽取弹窗在 #app 之外：整树重绘冲不掉它，改由这里同步 */
  if (state.screen === 'draft') syncCandHeights();   /* 必须排在 renderPick 之后：量的是弹窗里的新卡 */
  restorePickScroll();              /* 再排在 syncCandHeights 之后：见函数注释 */
  save();
}

function syncCandHeights() {
  const grid = $('candGrid');
  if (!grid) return;
  grid.style.setProperty('--cand-min-h', '0px');
  let h = 0;
  grid.querySelectorAll('.cand').forEach(el => { h = Math.max(h, el.offsetHeight); });
  if (h) grid.style.setProperty('--cand-min-h', h + 'px');
}

/* 【2026-09-13 修「手机上点最下面那张卡，弹窗自己往上跳一格」】
   还原时机必须排在 syncCandHeights() **之后**，不能像原先那样在 renderPick() 里就地写。
   原因：卡片统一高度是「先量后写」的（min-height 由 --cand-min-h 提供，取值见上）——
   重绘出来的新 grid 还没有这个内联值，10 张卡先按各自自然高度排（比统一高度矮一截），
   .sheet 的 scrollHeight 随之缩水；此刻写 scrollTop，值会被这个偏矮的中间态夹到新的、
   更小的上限，等高度随后写回也无法自愈 —— 玩家看到的正是「停在倒数第二张卡，
   还得往下滑一点才找到自己刚点的那张」，伴随一次内容高度回弹的抖动。
   三步（重绘 → 量高 → 还原位置）都在同一个同步任务里，浏览器只在末尾绘制一次，
   所以修正后过程中不会有可见跳动。
   下面 rAF 那次补写是给 iOS 的保险：字体与换行偶尔要到下一帧才定稿，高度一变
   scrollTop 会被再夹一次；第二帧发现值不对就补一次（玩家真滚了则不打扰——同一帧内滚不动）。 */
function restorePickScroll() {
  if (pickScrollKeep === null) return;
  const keep = pickScrollKeep;
  pickScrollKeep = null;
  const sheet = document.querySelector('#pickModal .sheet');
  if (!sheet || !state.pickOpen || state.screen !== 'draft') return;
  sheet.scrollTop = keep;
  requestAnimationFrame(() => {
    if (!state.pickOpen || !sheet.isConnected) return;
    if (Math.abs(sheet.scrollTop - keep) > 1) sheet.scrollTop = keep;
  });
}

/* ---------------------------------------------------------------- 事件 */

$('app').addEventListener('click', async e => {
  const t = e.target;

  const pace = t.closest('[data-pace]');
  if (pace) { state.pace = pace.dataset.pace; return render({}); }

  const mode = t.closest('[data-mode]');
  if (mode) { state.mode = mode.dataset.mode; return render({}); }

  const start = t.closest('[data-start]');
  if (start) {
    if (!state.pace) return;
    await enterDraft();
    return;
  }

  if (t.closest('[data-rules]')) return openModal('规则说明', rulesHtml());

  /* 抽取入口：点名单里那个空位（2026-09-13 用户口径）。
     选卡 / 确认入名单 / 整批换池三个动作都发生在弹窗里，归 #pickModal 自己的委托（见文件末尾）——
     弹窗挂在 #app 之外，这里的委托收不到它。 */
  if (t.closest('[data-openslot]')) return openPick();

  if (t.closest('[data-lock]')) {
    if (!isFull()) return;
    rollIfs();                       /* 名单锁定 = 掷定 IF（见文件头 ⚠️） */
    state.progress = 0;
    state.screen = 'season';
    return render({ page: true });
  }

  const rowsBtn = t.closest('[data-rows]');
  if (rowsBtn && rowsBtn.dataset.rows) {
    const k = rowsBtn.dataset.rows;
    state.flows[k] = !state.flows[k];
    render({ flow: state.flows[k] ? k : null });
    return;
  }

  if (t.closest('[data-advance]')) return advance();
  if (t.closest('[data-result]')) { state.screen = 'result'; return render({ page: true }); }
  if (t.closest('[data-back]')) { state.screen = 'season'; return render({ page: true }); }
  if (t.closest('[data-restart]')) return restart();

  if (t.closest('[data-evtrap]')) return openModal('规则陷阱 · 那一刀', trapBody());
  if (t.closest('[data-evif]')) return openModal('IF 世界线 · 本局变动', ifBody());
  if (t.closest('[data-evmiss]')) return openModal('错过的名马', missBody());
});

$('app').addEventListener('change', async e => {
  if (e.target.id === 'selSeason') {
    state.season = Number(e.target.value);
    await loadSeason(state.season);          /* 顶栏与届元信息都要读它，必须先载入 */
    render({});
  }
});

$('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
$('mClose').addEventListener('click', closeModal);

/* 抽取弹窗自己的事件委托（弹窗在 #app 之外，上面那个委托收不到它）。
   三个动作：选卡（开关）／确认入名单（唯一写 roster 的入口）／整批换池。 */
$('pickModal').addEventListener('click', e => {
  const t = e.target;
  if (t.id === 'pickModal' || t.id === 'pkClose') return closePick();

  const pick = t.closest('[data-pick]');
  if (pick) {
    const k = pick.dataset.pick;
    state.pick = state.pick === k ? null : k;      /* 再点同一张卡 ＝ 取消（选卡是开关） */
    return render({});
  }
  if (t.closest('[data-confirm]')) {
    if (!state.pick || isFull()) return;
    state.roster.push(state.pick);
    state.pick = null;
    /* 确认后即收起弹窗、回到名单（2026-09-13 用户口径）：先让玩家看着名单多出一行
       （5 牡 5 牝、牧场档、同父一眼可见），再自己决定何时抽下一轮。
       新一轮的候选与次数已顺手备好（startRound），所以关窗不需要任何额外操作，
       再点名单里的下一个空位就是了 —— 免费换批只发生在「确认」这一刻，
       本轮已用掉的换池次数不返还，但**下一轮的 3 次随 startRound 回满**。 */
    state.pickOpen = false;
    if (isFull()) state.batch = [];     /* 满员：空位用尽，候选区不再需要 */
    else startRound();                  /* 开下一轮：抽新一批 ＋ 本轮换池次数回满 3 */
    return render({ slot: true, pool: true });
  }
  if (t.closest('[data-refresh]')) {
    if (state.refreshes <= 0) return;
    state.refreshes--;
    state.pick = null;                             /* 换池即清掉未确认的选中，免得确认到上一批的马 */
    state.batch = sampleBatch();
    return render({ pool: true });
  }
});
$('btnHome').addEventListener('click', () => { state.screen = 'title'; render({ page: true }); });

/* 「继续存档」在每次渲染后重建 ⇒ 事件走 document 委托 */
document.addEventListener('click', async e => {
  if (e.target.id === 'btnContinue') {
    const s = loadSave();
    if (!s) return;
    const batch = s.batch || [];
    Object.assign(state, {
      season: s.season, pace: s.pace, mode: s.mode || 'lite',
      roster: s.roster || [], batch: batch, seen: s.seen || {},
      /* 本轮剩余次数：取存档值，但**夹到本轮上限** —— 旧档记的是整局 30 次，原样搬过来会凭空多出次数 */
      refreshes: Math.min(s.refreshes ?? REFRESH_PER_ROUND, REFRESH_PER_ROUND),
      progress: s.progress || 0, flows: s.flows || {},
      /* 状态三件套 + 开窗态原样恢复：roster / batch / pick / pickOpen。
         pick 必须校验它**仍在本批里** —— 脏存档或换过池的旧档里，它可能指向一匹已不在候选中的马。 */
      pick: (s.pick && batch.includes(s.pick)) ? s.pick : null,
      pickOpen: !!s.pickOpen && (s.roster || []).length < MAX,
      ifHits: s.ifHits || [], seenTrap: !!s.seenTrap, seenIf: !!s.seenIf,
      trapRemoved: Array.isArray(s.trapRemoved) ? s.trapRemoved : null,
      pendingIf: !!s.pendingIf
    });
    await loadSeason(state.season);
    /* 【2026-09-14】旧档（v=0.46 及以前）没有上面两个字段，就地补账 —— 两者都能从手上已有的信息
       确定性还原，不需要给存档升版本号、也不会补出与当初不同的结果：
       · trapRemoved：陷阱结果只依赖「名单 ＋ 段真值」（seg.seg 随 loadSeason 已到手，与逐场段无关），
         拿同一把尺重算即可，逐匹与当初那一刀一致；
       · pendingIf：定格只发生在「关掉事件卡」那一刻（见 closeModal）⇒ 终局 ＋ 命中 IF ＋ 尚未定格
         三者同时成立，当初存档时卡必然正开着，于是把这一状态还原回去。 */
    if (!state.trapRemoved && state.progress >= trapNode()) state.trapRemoved = settleTrap();
    if (!state.pendingIf && state.progress >= paceLen() && state.ifHits.length && !state.seenIf) state.pendingIf = true;

    if (state.progress === 0 && !isFull()) { await enterDraft(true); }
    else {
      state.screen = 'season';
      await preloadFor();
      render({ page: true });
      /* 玩家续档时正看着的那张 IF 事件卡不该凭空消失 —— 原地放回去，
         关掉它才定格总分（与 advance() 里终局那一刻的处置完全一致）。 */
      if (state.pendingIf) openModal('IF 世界线 · 本局变动', ifBody());
    }
  }
});

/* ------------------------------------------------------------ 流程动作 */

async function preloadFor() {
  if (state.progress < nameNode()) return;
  const cut = state.progress ? cutOf(state.progress) : cutOf(nameNode());
  const idx = segIndexOfCut(cut);
  if (idx >= 0) await ensureSegments(idx);
}

async function enterDraft(restore) {
  await loadSeason(state.season);            /* 换届后首进必须自取数据包 */
  if (!restore) { state.progress = 0; state.flows = {}; state.ifHits = []; state.trapRemoved = null; state.seenIf = false; state.pendingIf = false; state.seenTrap = false; state.refreshes = REFRESH_PER_ROUND; state.roster = []; state.batch = []; state.seen = {}; state.pick = null; state.pickOpen = false; }
  if (!state.roster.length && !state.batch.length) startRound();   /* 新的一轮：抽候选 ＋ 次数回满 */
  state.screen = 'draft';
  render({ page: true, pool: true });
}

/* 逐场明细按段懒加载（races/s1…s6，单段 100~760 KB）：节点 2 起要现场拉，
   手机上一等就是几秒 —— 期间必须把「继续模拟」置灰（2026-09-13 用户报「第二个节点加载慢」）。
   三处细节，缺一个都白按：
   ① 置灰要写在 await **之前**。先改 DOM 再等网络，主线程让出去，浏览器才有机会把这一帧画出来。
   ② 进度在数据落地之后才自增（原先 progress++ 在最前面）。否则等待期间再点一下，
      isDone() 仍是 false ⇒ 再 +1、再等一次 ⇒ **连点连跳节点**。顺带：拉失败时进度不动，
      按钮还回去，玩家再点一次就是重试。
   ③ advancing 锁住重入 —— 按钮置灰只挡得住"点按钮"，挡不住键盘/辅助设备的二次触发。 */
let advancing = false;

async function advance() {
  if (advancing || isDone()) return;
  const k = state.progress + 1;
  const needSeg = k >= nameNode() && segIndexOfCut(cutOf(k)) >= S().segLoaded;
  const btn = document.querySelector('[data-advance]');

  advancing = true;
  if (needSeg && btn) { btn.disabled = true; btn.textContent = '正在载入逐场…'; }
  try {
    if (k >= nameNode()) await ensureSegments(segIndexOfCut(cutOf(k)));
    state.progress = k;

    if (k === trapNode()) {
      state.trapRemoved = settleTrap();
      state.seenTrap = false;
      purgeIfsOfRemoved();           /* 被移除的马不该再有世界线（见该函数注释） */
    }
    let ifFired = false;
    if (k >= paceLen()) {
      if (state.ifHits.length && !state.seenIf) { ifFired = true; state.pendingIf = true; }
      else state.seenIf = true;
    }

    render({ page: true, table: true });   /* 整屏重绘，置灰的那个按钮随之被换掉 */

    if (k === trapNode()) openModal('规则陷阱 · 那一刀', trapBody());
    else if (ifFired) openModal('IF 世界线 · 本局变动', ifBody());
  } finally {
    advancing = false;
    /* 只收拾"失败路径"：render 没跑到，旧按钮还在页面上（isConnected），得手动还回去。
       成功时它已被重绘替换，isConnected 为 false，这里不动 —— 免得改到新按钮的文案。 */
    if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = '继续模拟（到 ' + cutOf(k) + '）'; }
  }
}

function restart() {
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { }
  Object.assign(state, {
    screen: 'title', season: state.season, pace: null, roster: [], batch: [], seen: {}, pick: null, pickOpen: false,
    refreshes: REFRESH_PER_ROUND, progress: 0, flows: {}, trapRemoved: null, ifHits: [],
    seenTrap: false, seenIf: false, pendingIf: false
  });
  render({ page: true });
}

function rulesHtml() {
  return '' +
    '<h4>选取规则</h4><ul>' +
    '<li>10 匹，须 <b>5 牡 5 牝</b>。</li>' +
    '<li>生産牧場：<b>社台系合计 ≤ 7 匹</b>，其中 <b>ノーザンファーム ≤ 5 匹</b>。' +
    '社台系 ＝ ノーザンファーム / 社台ファーム / 社台コーポレーション白老ファーム / 社台牧場；其余牧场不限。</li>' +
    '<li>同一父马至多 <b>2 匹</b>。</li>' +
    '<li>不合规的马会被移出名单（表中仍占一行、不计分）；候选卡<b>不标注牧场档位</b>，须自行判断。</li>' +
    '</ul>' +
    /* 【2026-09-13】候选弹窗底部的那段长说明搬到这里：弹窗内只留「怎么点」，
       规则细节（换池次数、已入名单不再出现、关窗不返还）集中在此，需要时一次看全。 */
    '<h4>抽取与换池</h4><ul>' +
    '<li>点名单里的<b>空位</b>抽出本轮 <b>10 条候选</b>；点卡片只<b>选中</b>（不立即入名单），再点一次取消。</li>' +
    '<li>点弹窗底部「<b>确认加入名单</b>」才计入（防误划）；确认后弹窗收起、自动换上全新一批候选，' +
    '<b>不消耗换池次数</b>。</li>' +
    '<li>换池是<b>整批</b>换掉 10 条，每轮 <b>' + REFRESH_PER_ROUND + ' 次</b>（换轮重置）、不消耗轮次。</li>' +
    '<li>已入名单的马不再出现在后续候选里；关窗＝放弃本次未确认的选中（换池次数不返还）。</li>' +
    '</ul>' +
    /* 【2026-09-13】IF 的口径从 IF 卡片顶部搬到这里（那张卡片开头原本有一段总起，
       在向玩家解说读法，出戏；见 ifBody）。这里只讲「IF 是什么、怎么算」，不复述卡面结构。 */
    '<h4>IF 世界线</h4><ul>' +
    '<li>名单里的名马<b>世界线可能变动</b>：换一场出走、挪一个着顺、换一次赏金，甚至整场撤出。</li>' +
    '<li>变动<b>落在赛果本身</b> —— 该马此后按新的世界线计分，读到的就是变动后的分数，' +
    '而不是在原分数上另行加减。</li>' +
    '<li>多数变动落在赏金区外：<b>成绩串会变，总分未必变</b>。变动在终局结算时发生，' +
    '总分须待事件卡关闭后才定格。</li>' +
    '</ul>';
}

/* ---------------------------------------------------------------- 启动 */

(async function boot() {
  $('app').innerHTML = '<div class="loadbox"><span class="spin"></span>正在载入数据…</div>';
  try {
    const man = await jgetManifest();            /* 版本先行：余下请求都要挂它 */
    DATA_V = man.buildId || man.generatedAt || null;
    const [dict, ife] = await Promise.all([jget('dict.json'), jget('if_events.json')]);
    DB.manifest = man; DB.dict = dict; DB.ifEvents = ife;
    state.season = man.seasons[0].id;
    await loadSeason(state.season);
    render({ page: true });
  } catch (err) {
    console.error('[ZOG] 数据载入失败：', err);
    $('app').innerHTML = '' +
      '<div class="errbox"><div class="ck">数据载入失败</div>' +
      '<h4>数据没载入成功</h4>' +
      '<p>请刷新页面重试；若反复失败，稍后再来。</p></div>';
  }
})();
