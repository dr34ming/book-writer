/// <reference types="@cloudflare/workers-types" />
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

interface Env {
	DB: D1Database;
}

export function getDb(platform: App.Platform) {
	const env = platform.env as Env;
	return drizzle(env.DB, { schema });
}

export type Database = ReturnType<typeof getDb>;
