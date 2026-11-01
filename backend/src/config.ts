import { readFileSync } from 'node:fs';
import { z } from 'zod';
export function config() {
  const env = z.object({ NODE_ENV: z.enum(['development','test','production']).default('development'), PORT: z.coerce.number().int().min(1).max(65535).default(3000), DATABASE_URL: z.string().optional(), DB_PASSWORD_FILE: z.string().optional(), DB_HOST: z.string().default('db'), DB_NAME: z.string().default('klasskvest'), DB_USER: z.string().default('klasskvest'), SESSION_HOURS: z.coerce.number().int().min(1).max(24).default(8) }).parse(process.env);
  const connectionString = env.DATABASE_URL ?? (env.DB_PASSWORD_FILE ? `postgresql://${encodeURIComponent(env.DB_USER)}:${encodeURIComponent(readFileSync(env.DB_PASSWORD_FILE,'utf8').trim())}@${env.DB_HOST}/${env.DB_NAME}` : undefined);
  if (!connectionString) throw new Error('DATABASE_URL or DB_PASSWORD_FILE required');
  return { ...env, connectionString };
}
