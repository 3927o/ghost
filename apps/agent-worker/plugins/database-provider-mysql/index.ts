import type { Context } from '@deepseek-ai/cordis'
import { provideDatabase } from '../database-provider/orm.ts'
export const name = 'database-provider-mysql'
export const provide = ['database']
export async function apply(ctx: Context, config: { url: string; poolSize?: number }) {
  await provideDatabase(ctx, { ...config, type: 'mysql' })
}
