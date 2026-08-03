import { Binding, SourceType, getMvuFields, getDbColumns } from '../schema';

/**
 * 数据库表数据结构（来自 AutoCardUpdaterAPI.exportTableAsJson）
 * 返回结构：{ mate: {...}, sheet_xxx: { name, content, sourceData: {ddl} }, ... }
 * - sheet_xxx 是内部 key，真正的表名是 sheet.name
 * - content[0] 是表头（中文列名），content[1..] 是数据行
 */
export interface DbSheet {
  name: string;
  content: any[][];
  sourceData?: { ddl?: string };
}

/** 数据库 API 类型（参考《数据库-模板变量与条件表达式》文档） */
interface AutoCardUpdaterAPI {
  exportTableAsJson: () => Record<string, any>;
  /** 模板结构；聊天数据尚未灌入时 export 可能为空，可用模板兜底列名 */
  getTableTemplate?: () => Record<string, any> | null;
  registerTableUpdateCallback?: (cb: () => void) => void;
  unregisterTableUpdateCallback?: (cb: () => void) => void;
}

/**
 * 从当前 window 或父级 window 获取数据库 API。
 * 前端界面运行在 iframe 内，数据库插件挂在酒馆主页面 window 上，
 * 因此需要尝试 window.parent / window.top。
 */
function pickDbApi(): AutoCardUpdaterAPI | null {
  const candidates: any[] = [window, (window as any).parent, (window as any).top];
  for (const w of candidates) {
    try {
      const api = w?.AutoCardUpdaterAPI;
      if (api && typeof api.exportTableAsJson === 'function') return api;
    } catch {
      // 跨域访问会抛错，忽略
    }
  }
  return null;
}

let mvuReady = false;
let dbApi: AutoCardUpdaterAPI | null = null;
let dbBound = false;
/** 数据库快照：原始对象形式 { sheet_xxx: {...} } */
let dbSnapshot: Record<string, any> = {};
const dbListeners = new Set<() => void>();
const readyListeners = new Set<() => void>();

function notifyReady() {
  readyListeners.forEach(fn => {
    try {
      fn();
    } catch {
      /* ignore */
    }
  });
}

/** 就绪状态变化（MVU / 数据库）时通知 UI */
export function onDataSourceReady(fn: () => void) {
  readyListeners.add(fn);
  return () => readyListeners.delete(fn);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms);
    p.then(
      v => {
        window.clearTimeout(t);
        resolve(v);
      },
      e => {
        window.clearTimeout(t);
        reject(e);
      },
    );
  });
}

function bindDbApi(api: AutoCardUpdaterAPI) {
  dbApi = api;
  refreshDbSnapshot();
  if (!dbBound && api.registerTableUpdateCallback) {
    dbBound = true;
    const cb = () => {
      refreshDbSnapshot();
      dbListeners.forEach(fn => fn());
    };
    api.registerTableUpdateCallback(cb);
    $(window).on('pagehide', () => api.unregisterTableUpdateCallback?.(cb));
  }
  notifyReady();
}

/** 尝试绑定数据库 API（可重复调用，已绑定则刷新快照） */
export function ensureDbApi(): boolean {
  if (dbApi) {
    refreshDbSnapshot();
    return true;
  }
  const api = pickDbApi();
  if (!api) return false;
  bindDbApi(api);
  console.info('[自定义状态栏] AutoCardUpdaterAPI 已就绪');
  return true;
}

async function initMvu() {
  // 无 MVU 的角色卡上 waitGlobalInitialized('Mvu') 永不 resolve，必须超时
  try {
    await withTimeout(waitGlobalInitialized('Mvu'), 2500, 'MVU');
    mvuReady = true;
    notifyReady();
    console.info('[自定义状态栏] MVU 已就绪');
  } catch (e) {
    mvuReady = false;
    notifyReady();
    console.warn('[自定义状态栏] MVU 未就绪，MVU 数据源将不可用', e);
  }
}

async function initDb() {
  // 与 MVU 并行探测；插件可能晚于界面加载
  for (let i = 0; i < 40 && !dbApi; i++) {
    if (ensureDbApi()) return;
    await new Promise(r => setTimeout(r, 250));
  }
  if (!dbApi) {
    console.warn('[自定义状态栏] AutoCardUpdaterAPI 未检测到，数据库数据源将不可用');
    notifyReady();
  }
}

/** 初始化数据源：MVU 与数据库并行，互不阻塞 */
export async function initDataSource() {
  await Promise.all([initMvu(), initDb()]);
}

function hasSheetKeys(obj: Record<string, any> | null | undefined): boolean {
  if (!obj) return false;
  for (const key in obj) {
    if (key.startsWith('sheet_')) return true;
  }
  return false;
}

function refreshDbSnapshot() {
  if (!dbApi) return;
  try {
    let data = dbApi.exportTableAsJson() ?? {};
    // 换卡/冷启动时 export 常短暂为空；模板仍有表结构，可先用来选列
    if (!hasSheetKeys(data) && typeof dbApi.getTableTemplate === 'function') {
      const tpl = dbApi.getTableTemplate();
      if (hasSheetKeys(tpl ?? undefined)) data = tpl ?? {};
    }
    dbSnapshot = data;
  } catch (e) {
    console.error('[自定义状态栏] 读取数据库快照失败', e);
    dbSnapshot = {};
  }
}

/** MVU 是否可用 */
export function isMvuReady() {
  return mvuReady;
}

/** 数据库是否可用（打开选择器时再探测一次，避免初始化时序问题） */
export function isDbReady() {
  if (dbApi) return true;
  return ensureDbApi();
}

/** 获取数据库所有表（用于选择器列出表） */
export function getDbTables(): DbSheet[] {
  ensureDbApi();
  const tables: DbSheet[] = [];
  for (const key in dbSnapshot) {
    if (!key.startsWith('sheet_')) continue;
    const sheet = dbSnapshot[key];
    if (sheet && sheet.name && Array.isArray(sheet.content)) {
      tables.push({ name: sheet.name, content: sheet.content, sourceData: sheet.sourceData });
    }
  }
  return tables;
}

/** 按表名取一张表（兼容中文显示名） */
export function getDbSheet(tableName: string): DbSheet | null {
  return getDbTables().find(t => t.name === tableName) ?? null;
}

/** 取某表数据行数（content[0] 是表头，[1..] 是数据） */
export function getDbRowCount(table: string): number {
  const t = getDbSheet(table);
  if (!t || !t.content || t.content.length < 2) return 0;
  return t.content.length - 1;
}

/** 按 1 起的数据行号（1..N）取某列原始值，不做行定位容错；越界返回 undefined */
export function getDbRowCell(table: string, dataRow: number, column: string): any {
  if (!table || !column) return undefined;
  const t = getDbSheet(table);
  if (!t || !t.content || t.content.length < 2) return undefined;
  const headers = t.content[0] as any[];
  const colIdx = headers.indexOf(column);
  if (colIdx < 0) return undefined;
  const idx = 1 + Math.max(0, Math.min(t.content.length - 2, dataRow - 1));
  return t.content[idx]?.[colIdx];
}

/** 监听数据库变更 */
export function onDbUpdate(fn: () => void) {
  dbListeners.add(fn);
  return () => dbListeners.delete(fn);
}

/**
 * 获取 MVU stat_data。
 * 脚本是全局 iframe，不能用 getCurrentMessageId()；固定读最新消息楼层。
 */
export function getMvuStatData(): Record<string, any> {
  if (!mvuReady) return {};
  try {
    // 空聊天时 latest 会越界，静默返回空对象
    const chat =
      (window as any).parent?.SillyTavern?.getContext?.()?.chat ??
      (window as any).SillyTavern?.getContext?.()?.chat;
    if (Array.isArray(chat) && chat.length === 0) return {};
  } catch {
    /* ignore cross-origin / missing */
  }
  try {
    const variables = Mvu.getMvuData({ type: 'message', message_id: 'latest' });
    return _.get(variables, 'stat_data', {}) ?? {};
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 无消息楼层时属预期，不刷 error
    if (msg.includes('超出了范围') || msg.includes('out of range')) {
      return {};
    }
    console.error('[自定义状态栏] 获取 MVU 数据失败', e);
    return {};
  }
}

/** 按 parent.field 路径从 stat_data 取值 */
export function getMvuValue(parent: string, field: string): any {
  const stat = getMvuStatData();
  const path = parent ? (field ? `${parent}.${field}` : parent) : field;
  return _.get(stat, path);
}

/** 多字段：返回 { name, value }[]，单字段时也统一格式 */
export function getMvuFieldEntries(parent: string, fields: string[]): { name: string; value: any }[] {
  if (!fields.length) {
    if (parent) {
      const v = getMvuValue(parent, '');
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return Object.entries(v).map(([name, value]) => ({ name, value }));
      }
      return [{ name: parent.split('.').pop() || parent, value: v }];
    }
    return [];
  }
  return fields.map(name => ({ name, value: getMvuValue(parent, name) }));
}

/** 从数据库取值：表名 + 行定位 + 列名 */
export function getDbValue(table: string, row: Binding['db_row'], column: string): any {
  if (!table || !column) return undefined;
  const t = getDbSheet(table);
  if (!t || !t.content || t.content.length < 2) return undefined;
  const headers = t.content[0] as any[];
  const colIdx = headers.indexOf(column);
  if (colIdx < 0) return undefined;
  const dataRowCount = t.content.length - 1;
  const isSingleRow = dataRowCount === 1;
  let rowIdx = 1; // 默认第一行数据
  if (row === 'latest') {
    rowIdx = t.content.length - 1;
  } else if (typeof row === 'number') {
    rowIdx = row;
  } else if (row && typeof row === 'object') {
    const matchColIdx = headers.indexOf(row.col);
    if (matchColIdx >= 0) {
      rowIdx = t.content.findIndex((r, i) => i >= 1 && r[matchColIdx] === row.value);
    }
    if (rowIdx < 0) {
      // 多行表匹配失败：显式表达"没匹配上"，保持显示空
      if (!isSingleRow) return undefined;
      // 单行表：匹配列/值可能因换表后已不存在，回退到唯一数据行
      rowIdx = 1;
    }
  }
  // rowIdx 越界（如多行表残留的大 row_id 用到单行表上）时兜底
  if (rowIdx < 1 || rowIdx >= t.content.length) {
    rowIdx = isSingleRow ? 1 : t.content.length - 1;
  }
  return t.content[rowIdx]?.[colIdx];
}

export function getDbColumnEntries(
  table: string,
  row: Binding['db_row'],
  columns: string[],
): { name: string; value: any }[] {
  if (!columns.length) return [];
  return columns.map(name => ({ name, value: getDbValue(table, row, name) }));
}

/** 通用取数：根据 source + binding 取值（单值兼容） */
export function resolveValue(source: SourceType, binding: Binding): any {
  switch (source) {
    case 'mvu': {
      const fields = getMvuFields(binding);
      if (fields.length <= 1) {
        return getMvuValue(binding.mvu_parent, fields[0] || binding.mvu_field);
      }
      return getMvuFieldEntries(binding.mvu_parent, fields);
    }
    case 'db': {
      const cols = getDbColumns(binding);
      if (cols.length <= 1) {
        return getDbValue(binding.db_table, binding.db_row, cols[0] || binding.db_column);
      }
      return getDbColumnEntries(binding.db_table, binding.db_row, cols);
    }
    case 'static':
      return binding.static_value;
  }
}

/** 统一解析为条目列表，便于多字段同列展示 */
export function resolveEntries(
  source: SourceType,
  binding: Binding,
): { name: string; value: any }[] {
  switch (source) {
    case 'mvu': {
      const fields = getMvuFields(binding);
      return getMvuFieldEntries(binding.mvu_parent, fields);
    }
    case 'db': {
      const cols = getDbColumns(binding);
      if (!cols.length) return [];
      return getDbColumnEntries(binding.db_table, binding.db_row, cols);
    }
    case 'static':
      return [{ name: '', value: binding.static_value }];
  }
}

/** 把任意值格式化为字符串 */
export function formatValue(v: any): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v) && v.length && typeof v[0] === 'object' && 'name' in v[0] && 'value' in v[0]) {
    return v.map((x: any) => `${x.name}: ${formatValue(x.value)}`).join(' · ');
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * 短文案 chip 边框阈值：按「分割后片段」长度判断。
 * 心声等长句也需要边框；超长（如大段正文）仍 plain，避免整屏大框。
 * chip 本身已有 max-width + ellipsis，中长句可安全加框。
 */
export const CHIP_MAX_LEN = 2000;

export function isShortChip(text: string, maxLen = CHIP_MAX_LEN): boolean {
  // text 已是 split 后的单段；勿再拿整段原文比
  return !!text && String(text).length <= maxLen;
}

function splitBySlash(s: string): string[] {
  if (!s || /^https?:\/\//i.test(s) || !/[\/／]/.test(s)) return s ? [s] : [];
  return s.split(/\s*[\/／]\s*/).map(x => x.trim()).filter(Boolean);
}

/**
 * 将数据库/MVU 中可能带分隔符的字符串拆成展示片段。
 * 顺序：字面 /n、\n → 换行 → 中英文分号 ;； → 斜杠 /／（两侧可有空格）。
 * 例：
 * - "Lim / 雨宮春奈 / 雨宮悠奈"
 * - "A:xx;B:yy；C:zz"
 * - "第一行\n第二行" 或 "第一行/n第二行"
 */
export function splitDisplayParts(raw: string): string[] {
  if (raw === undefined || raw === null) return [];
  let s = String(raw).trim();
  if (!s) return [];
  s = s.replace(/\\n/g, '\n').replace(/\/n/g, '\n');
  const lines = s.split(/\r?\n+/).map(x => x.trim()).filter(Boolean);
  const parts: string[] = [];
  for (const line of lines) {
    const bySemi = /[;；]/.test(line)
      ? line.split(/[;；]+/).map(x => x.trim()).filter(Boolean)
      : [line];
    for (const seg of bySemi) {
      parts.push(...splitBySlash(seg));
    }
  }
  return parts;
}

/** 任意值 → 展示片段列表（自动 format + 分隔拆分） */
export function displayParts(v: any): string[] {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v) && v.length && typeof v[0] === 'object' && 'name' in v[0] && 'value' in v[0]) {
    return v.flatMap((x: any) => {
      const text = x.name ? `${x.name}: ${formatValue(x.value)}` : formatValue(x.value);
      return splitDisplayParts(text);
    });
  }
  if (Array.isArray(v)) {
    return v.flatMap(x => {
      const t = formatValue(x);
      const parts = splitDisplayParts(t);
      return parts.length ? parts : t ? [t] : [];
    });
  }
  if (typeof v === 'object') {
    return splitDisplayParts(formatValue(v));
  }
  const parts = splitDisplayParts(String(v));
  return parts.length ? parts : [String(v)];
}

/** 把任意值转为数字（用于进度条） */
export function toNumber(v: any): number {
  if (Array.isArray(v) && v.length && typeof v[0] === 'object' && 'value' in v[0]) {
    return toNumber(v[0].value);
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
