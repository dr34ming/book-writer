/// <reference types="@sveltejs/kit" />
/// <reference types="@sveltejs/adapter-cloudflare" />

declare global {
	namespace App {
		interface Locals {
			user: {
				id: number;
				username: string;
				display_name: string;
			} | null;
		}
		interface Platform {
			env: {
				DB: D1Database;
			};
			context: ExecutionContext;
			caches: CacheStorage & { default: Cache };
		}
	}
}

export {};
