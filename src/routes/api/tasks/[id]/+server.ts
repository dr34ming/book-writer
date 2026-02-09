import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { bookTasks } from '$lib/server/db/schema';
import { eq, and, asc } from 'drizzle-orm';
import { logEvent } from '$lib/server/events';

export const PATCH: RequestHandler = async ({ params, request, platform }) => {
	if (!platform) return json({ error: 'no platform' }, { status: 500 });
	const db = getDb(platform);
	const id = parseInt(params.id);
	const { status } = await request.json() as { status: string };

	const [before] = await db.select().from(bookTasks).where(eq(bookTasks.id, id)).limit(1);

	await db.update(bookTasks).set({ status }).where(eq(bookTasks.id, id));

	const [task] = await db.select().from(bookTasks).where(eq(bookTasks.id, id)).limit(1);

	await logEvent(db, {
		book_id: task.book_id,
		action: 'update_task',
		entity_type: 'task',
		entity_id: id,
		before_state: before,
		after_state: task
	});

	const tasks = await db
		.select()
		.from(bookTasks)
		.where(and(eq(bookTasks.book_id, task.book_id), eq(bookTasks.status, 'open')))
		.orderBy(asc(bookTasks.created_at));

	return json({ tasks });
};
