import type { AiConfig } from './config';
import { chatUrl } from './config';
import type { MarketSnapshot } from './context';
import { snapshotToText } from './context';
import { firstToolCall, type ToolCall } from './tools';

/** 垂直角色约束：只做单标的时序动量择时，不许编造数据 */
export const SYSTEM_PROMPT = [
  '你是一名量化动量择时分析师，服务对象是正在使用「动能动量策略」页面的投资者。',
  '你只回答与该策略、该标的、该组参数相关的问题；超出范围的请求（如预测点位、推荐具体买卖时点、打听内幕）要明确拒绝并说明原因。',
  '',
  '【硬性规则】',
  '1. 只能使用【事实快照】里出现的数字。快照没有的数据就说「快照未提供」，绝不臆造价格、收益率、财报或新闻。',
  '2. 任何结论都要给出依据：引用快照里的具体数值（如「区间动量 -8.66% 低于开仓阈值 2%」）。',
  '3. 策略是趋势跟踪，震荡市会反复止损；提到操作时必须说明失效条件与止损位。',
  '4. 不构成投资建议，结尾用一句话提示风险。',
  '5. 需要改参数时调用 set_momentum_params；需要切标的调用 switch_symbol；只解释不改动时调用 explain_signal。',
  '6. 一次只调用一个工具，调用后在回复里说明你改了什么、为什么。',
  '',
  '【输出格式】',
  '- 用简体中文，先给结论（一到两句），再给依据，最后给下一步动作。',
  '- 涉及价位保留两位小数，涉及百分比保留两位小数。',
  '- 不超过 400 字，不使用表格。'
].join('\n');

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AgentReply {
  text: string;
  toolCall: ToolCall | null;
  raw: unknown;
}

export interface AgentRequest {
  cfg: AiConfig;
  snapshot: MarketSnapshot;
  history: { role: 'user' | 'assistant'; content: string }[];
  question: string;
}

/** 组装消息：system 带事实快照，历史只保留最近 6 轮 */
export function buildMessages(req: AgentRequest): ChatMessage[] {
  const facts = snapshotToText(req.snapshot);
  const msgs: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'system',
      content: '【事实快照】（唯一可信数据源，截至 ' + req.snapshot.lastDate + '）\n' + facts
    }
  ];
  for (const h of req.history.slice(-6)) msgs.push({ role: h.role, content: h.content });
  msgs.push({ role: 'user', content: req.question });
  return msgs;
}

export interface AgentCallResult {
  ok: boolean;
  reply: AgentReply | null;
  error: string | null;
}

/** 发送请求；失败时返回人话错误，不吞原因 */
export async function callAgent(
  req: AgentRequest,
  tools: unknown,
  signal?: AbortSignal
): Promise<AgentCallResult> {
  const url = chatUrl(req.cfg);
  if (!url) return { ok: false, reply: null, error: 'API 地址为空，请先在「AI 设置」里填写' };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + req.cfg.apiKey.trim()
      },
      body: JSON.stringify({
        model: req.cfg.model.trim(),
        temperature: req.cfg.temperature,
        messages: buildMessages(req),
        tools,
        tool_choice: 'auto'
      })
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/abort/i.test(m)) return { ok: false, reply: null, error: '请求已取消' };
    return {
      ok: false,
      reply: null,
      error:
        '网络请求失败：' +
        m +
        '。若是浏览器 CORS 限制，请把 API 地址填成同源的 /ai 代理路径（开发服务器已内置）。'
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
    return { ok: false, reply: null, error: 'HTTP ' + res.status + hint + (detail ? '：' + detail : '') };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, reply: null, error: '响应不是合法 JSON，请检查 API 地址是否指向 chat completions' };
  }

  const msg = (data as { choices?: { message?: unknown }[] })?.choices?.[0]?.message;
  if (!msg) return { ok: false, reply: null, error: '响应里没有 choices[0].message' };

  const toolCall = firstToolCall(msg);
  const content = (msg as { content?: string }).content ?? '';
  return { ok: true, reply: { text: content.trim(), toolCall, raw: data }, error: null };
}
