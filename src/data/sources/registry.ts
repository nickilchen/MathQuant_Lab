/** 源注册表：按标的解析取数源链（偏好源优先，其余按注册顺序） */
import type { SymbolDef } from '../types';
import { tencentSource } from './tencent';
import { eastmoneySource } from './eastmoney';
import { naverSource } from './naver';
import { sinaSource } from './sina';
import { yahooSource } from './yahoo';
import { yahooJpSource } from './yahooJp';
import type { KlineSource } from './types';

export const SOURCES: KlineSource[] = [tencentSource, eastmoneySource, naverSource, sinaSource, yahooJpSource, yahooSource];

export function sourceChain(sym: SymbolDef): KlineSource[] {
  const capable = SOURCES.filter((s) => s.canHandle(sym));
  if (sym.preferSource) {
    const pref = capable.find((s) => s.id === sym.preferSource);
    if (pref) return [pref, ...capable.filter((s) => s.id !== sym.preferSource)];
  }
  return capable;
}

export type { KlineSource };
