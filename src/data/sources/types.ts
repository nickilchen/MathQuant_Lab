/** 可插拔数据源接口：每个源实现 canHandle + fetch，registry 按标的解析源链 */
import type { Bar, DataSource, SymbolDef } from '../types';

export interface KlineSource {
  id: DataSource;
  label: string;
  /** 该源是否能服务此标的 */
  canHandle(sym: SymbolDef): boolean;
  /** 取最近 days 根日线；失败应抛错（由调用方降级） */
  fetch(sym: SymbolDef, days: number): Promise<Bar[]>;
}
