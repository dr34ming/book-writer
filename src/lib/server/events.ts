import type { Database } from '$lib/server/db';
import { events } from '$lib/server/db/schema';

export async function logEvent(
	db: Database,
	params: {
		book_id: number;
		session_id?: number;
		action: string;
		entity_type: string;
		entity_id?: number;
		before_state?: unknown;
		after_state?: unknown;
		chat_snapshot?: unknown;
		source?: 'user' | 'ai';
	}
) {
	await db.insert(events).values({
		book_id: params.book_id,
		session_id: params.session_id ?? null,
		action: params.action,
		entity_type: params.entity_type,
		entity_id: params.entity_id ?? null,
		before_state: params.before_state ? JSON.stringify(params.before_state) : null,
		after_state: params.after_state ? JSON.stringify(params.after_state) : null,
		chat_snapshot: params.chat_snapshot ? JSON.stringify(params.chat_snapshot) : null,
		source: params.source ?? 'user'
	});
}
