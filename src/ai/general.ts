/**
 * 通用 AI 指标解读（只读）
 *
 * 与 ai/agent.ts（动量页专用、带调参/切标工具）分工：
 *   - agent.ts：只服务动量页，允许模型改参数、切标的；
 *   - general.ts：服务所有指标页，只解读本页事实快照，**不提供任何工具**，
 *     模型无法改页面状态，只能基于给定数字做解释。
 *
 * 隐私：配置（含 API Key）只从 localStorage 读取，请求直发用户自己填写的
 * OpenAI 兼容地址，不经项目服务器、不写日志、不进 URL、仓库零存储。
 */
import type { AiConfig } from './config';
import { chatUrl } from './config';

/** 通用只读分析师的角色约束 */
export const GENERAL_SYSTEM_PROMPT = [
  '你是一名严谨的量化分析解读员，服务对象是正在使用本站各类数学分析页面的投资者。',
  '你的任务：对用户给出的【事实快照】做清晰、可复核的解读，帮助他理解这些指标意味着什么。',
  '',
  '【硬性规则】',
  '1. 只能使用【事实快照】里出现的数字与文字。快照没有的数据就说「快照未提供」，绝不臆造价格、收益、财报、新闻或任何数值。',
  '2. 每条结论都要引用快照里的具体数值作为依据，例如「夏普 1.2 说明风险调整后收益尚可」。',
  '3. 你只能解读与解释，不能也不允许建议用户修改任何参数、切换标的或给出具体买卖时点；若被要求这样做，说明本助手只做解读。',
  '4. 明确区分「事实」与「推断」：推断要用「可能 / 通常意味着 / 需结合其他指标」等措辞，不把推断说成事实。',
  '5. 不构成投资建议，结尾用一句话提示风险。',
  '',
  '【输出格式】',
  '- 用简体中文，先给一句话总览，再分点解读关键指标（3~6 点），最后给一句风险提示。',
  '- 涉及价位保留两位小数，百分比保留两位小数，不使用表格，不超过 500 字。'
].join('\n');

export interface GeneralSnapshot {
  /** 页面 / 模块名，如「技术面体检」 */
  module: string;
  /** 标的名（可选） */
  symbol?: string;
  /** 事实条目：名称 + 值 */
  facts: { label: string; value: string }[];
  /** 页面给出的补充口径说明（可选） */
  note?: string;
}

/** 把事实快照压成给模型看的紧凑文本 */
export function snapshotToFactsText(s: GeneralSnapshot): string {
  const L: string[] = [];
  if (s.symbol) L.push('标的：' + s.symbol);
  L.push('分析模块：' + s.module);
  L.push('【事实快照】（唯一可信数据源，不得超出以下数值）：');
  for (const f of s.facts) L.push('- ' + f.label + '：' + f.value);
  if (s.note) L.push('口径说明：' + s.note);
  return L.join('\n');
}

export interface GeneralChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GeneralReply {
  ok: boolean;
  text: string | null;
  error: string | null;
}

/**
 * 发送一次只读解读请求。历史只保留最近 6 轮；不传 tools，杜绝模型改页面。
 */
export async function callGeneralAnalysis(
  cfg: AiConfig,
  snapshot: GeneralSnapshot,
  history: { role: 'user' | 'assistant'; content: string }[],
  question: string,
  signal?: AbortSignal
): Promise<GeneralReply> {
  const url = chatUrl(cfg);
  if (!url) return { ok: false, text: null, error: 'API 地址为空，请先在「AI 设置」里填写' };

  const messages: GeneralChatMessage[] = [
    { role: 'system', content: GENERAL_SYSTEM_PROMPT },
    { role: 'system', content: snapshotToFactsText(snapshot) }
  ];
  for (const h of history.slice(-6)) messages.push({ role: h.role, content: h.content });
  messages.push({ role: 'user', content: question });

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey.trim()
      },
      body: JSON.stringify({
        model: cfg.model.trim(),
        temperature: cfg.temperature,
        messages
        // 注意：刻意不传 tools / tool_choice，模型没有可调用的页面修改工具
      })
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/abort/i.test(m)) return { ok: false, text: null, error: '请求已取消' };
    return {
      ok: false,
      text: null,
      error: '网络请求失败：' + m + '。若浏览器直连被 CORS 拦截，可把地址改为同源 /ai 代理。'
    };
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      detail = '';
    }
    const hint =
      res.status === 401
        ? '（Key 无效或已过期）'
        : res.status === 429
          ? '（触发限流，稍后重试）'
          : res.status === 404
            ? '（模型名或地址不对）'
            : '';
    return { ok: false, text: null, error: 'HTTP ' + res.status + hint + (detail ? '：' + detail : '') };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, text: null, error: '响应不是合法 JSON，请检查 API 地址是否指向 chat completions' };
  }
  const msg = (data as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message;
  if (!msg) return { ok: false, text: null, error: '响应里没有 choices[0].message' };
  return { ok: true, text: (msg.content ?? '').trim(), error: null };
}
