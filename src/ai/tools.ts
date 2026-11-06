import type { MomParams } from '../math/momentum';

export type AgentToolName = 'set_momentum_params' | 'switch_symbol' | 'explain_signal';

export interface ToolCall {
  name: AgentToolName;
  args: Record<string, unknown>;
}

/** OpenAI function calling 工具声明 */
export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'set_momentum_params',
      description:
        '修改当前动量策略参数并让页面立即重算。仅在用户明确要求调参、或你判断参数与当前市场状态不匹配并已说明理由时调用。',
      parameters: {
        type: 'object',
        properties: {
          lookback: { type: 'number', description: '动量回看窗口（交易日），常用 63/126/252' },
          skip: { type: 'number', description: '跳过最近 N 日，常用 0/5/21' },
          maLen: { type: 'number', description: '趋势过滤均线长度，0 表示关闭，常用 100/200' },
          entry: { type: 'number', description: '开仓阈值，小数，如 0.02 表示 2%' },
          exit: { type: 'number', description: '离场阈值，小数，如 -0.02 表示 -2%' },
          targetVol: { type: 'number', description: '年化目标波动，0 表示关闭，如 0.15' },
          cap: { type: 'number', description: '单边仓位上限，0~1，如 1 表示满仓' }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'switch_symbol',
      description: '把页面切换到另一个标的。code 必须是页面支持的市场代码，例如 sh600519、hk00700、usAAPL。',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string', description: '标的代码' } },
        required: ['code'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'explain_signal',
      description: '当用户只想理解信号含义、不需要改参数时调用。',
      parameters: {
        type: 'object',
        properties: { aspect: { type: 'string', description: '要解释的方面：动量、趋势、仓位、触发价、回测' } },
        additionalProperties: false
      }
    }
  }
];

const PARAM_KEYS: (keyof MomParams)[] = ['lookback', 'skip', 'maLen', 'entry', 'exit', 'targetVol', 'cap'];

const BOUNDS: Record<keyof MomParams, [number, number]> = {
  lookback: [5, 504],
  skip: [0, 63],
  maLen: [0, 400],
  entry: [-0.5, 0.5],
  exit: [-0.5, 0.5],
  targetVol: [0, 1],
  cap: [0, 1]
};

/** 合并模型给的参数，越界值夹紧而非丢弃 */
export function mergeParams(
  cur: MomParams,
  args: Record<string, unknown>
): { next: MomParams; changed: string[] } {
  const next: MomParams = { ...cur };
  const changed: string[] = [];
  for (const k of PARAM_KEYS) {
    const raw = args[k];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const [lo, hi] = BOUNDS[k];
    const v = Math.max(lo, Math.min(hi, raw));
    if (Math.abs(next[k] - v) > 1e-9) {
      next[k] = v;
      changed.push(k);
    }
  }
  return { next, changed };
}

/** 从 OpenAI 响应里取第一个工具调用；无法解析时返回 null 而不抛错 */
export function firstToolCall(msg: unknown): ToolCall | null {
  const m = msg as { tool_calls?: { function?: { name?: string; arguments?: string } }[] } | null;
  const tc = m?.tool_calls?.[0]?.function;
  if (!tc || !tc.name) return null;
  const name = tc.name as AgentToolName;
  if (name !== 'set_momentum_params' && name !== 'switch_symbol' && name !== 'explain_signal') return null;
  let args: Record<string, unknown> = {};
  try {
    const p = JSON.parse(tc.arguments || '{}') as unknown;
    if (p && typeof p === 'object' && !Array.isArray(p)) args = p as Record<string, unknown>;
  } catch {
    args = {};
  }
  return { name, args };
}
