import type {} from '@deepseek-ai/cordis'
import type { DatabaseAccess, EntityManager } from '@ghost/database-client'

declare module '@deepseek-ai/cordis' { interface Context { database: DatabaseService } }
/** Service contract. Registration is owned by the concrete provider's ordered effect. */
export abstract class DatabaseService implements DatabaseAccess {
  abstract read<T>(operation: (manager: EntityManager) => Promise<T>): Promise<T>
  abstract transaction<T>(operation: (manager: EntityManager) => Promise<T>): Promise<T>
}
