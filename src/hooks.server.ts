import type { Handle } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

const EMAIL_TO_USERNAME: Record<string, string> = {
	'chiwiz@mac.com': 'jackie',
	'jonathan.yankovich@gmail.com': 'jonathan'
};

export const handle: Handle = async ({ event, resolve }) => {
	// Try Cloudflare Access header first
	const email = event.request.headers.get('cf-access-authenticated-user-email');
	let username: string | null = null;

	if (email) {
		username = EMAIL_TO_USERNAME[email] ?? null;
	}

	// Then check cookie
	if (!username) {
		username = event.cookies.get('user') ?? null;
	}

	// No auth → user stays null
	if (!username) {
		event.locals.user = null;
		return resolve(event);
	}

	if (event.platform) {
		const db = getDb(event.platform);
		const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);

		if (user) {
			event.locals.user = {
				id: user.id,
				username: user.username,
				display_name: user.display_name
			};
		} else {
			event.locals.user = null;
		}
	} else {
		// Dev without wrangler — stub user
		event.locals.user = { id: 1, username, display_name: username };
	}

	return resolve(event);
};
