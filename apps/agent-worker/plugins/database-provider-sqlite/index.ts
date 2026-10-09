import type { Context } from '@deepseek-ai/cordis'
import { provideDatabase } from '../database-provider/orm.ts'
export const name = 'database-provider-sqlite'
export const provide = ['database']
export async function apply(ctx: Context, config: { path: string }) {
  await provideDatabase(ctx, { ...config, type: 'sqlite' })
}
