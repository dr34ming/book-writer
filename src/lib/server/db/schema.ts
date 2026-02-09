import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	username: text('username').notNull().unique(),
	display_name: text('display_name').notNull(),
	created_at: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`)
});

export const books = sqliteTable('books', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	title: text('title').notNull(),
	description: text('description'),
	user_id: integer('user_id')
		.notNull()
		.references(() => users.id),
	created_at: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	updated_at: text('updated_at')
		.notNull()
		.default(sql`(datetime('now'))`)
});

export const chapters = sqliteTable('chapters', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	book_id: integer('book_id')
		.notNull()
		.references(() => books.id, { onDelete: 'cascade' }),
	title: text('title').notNull(),
	position: integer('position').notNull(),
	outline: text('outline'),
	created_at: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	updated_at: text('updated_at')
		.notNull()
		.default(sql`(datetime('now'))`)
});

export const paragraphs = sqliteTable('paragraphs', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	chapter_id: integer('chapter_id')
		.notNull()
		.references(() => chapters.id, { onDelete: 'cascade' }),
	content: text('content').notNull(),
	position: integer('position').notNull(),
	created_at: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	updated_at: text('updated_at')
		.notNull()
		.default(sql`(datetime('now'))`)
});

export const sessions = sqliteTable('sessions', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	book_id: integer('book_id')
		.notNull()
		.references(() => books.id, { onDelete: 'cascade' }),
	transcript: text('transcript'),
	summary: text('summary'),
	mode: text('mode').notNull().default('conversation'),
	created_at: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	updated_at: text('updated_at')
		.notNull()
		.default(sql`(datetime('now'))`)
});

export const messages = sqliteTable('messages', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	session_id: integer('session_id')
		.notNull()
		.references(() => sessions.id, { onDelete: 'cascade' }),
	role: text('role').notNull(),
	content: text('content').notNull(),
	created_at: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`)
});

export const projectNotes = sqliteTable(
	'project_notes',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		book_id: integer('book_id')
			.notNull()
			.references(() => books.id, { onDelete: 'cascade' }),
		key: text('key').notNull(),
		value: text('value'),
		created_at: text('created_at')
			.notNull()
			.default(sql`(datetime('now'))`),
		updated_at: text('updated_at')
			.notNull()
			.default(sql`(datetime('now'))`)
	},
	(table) => [uniqueIndex('project_notes_book_id_key_unique').on(table.book_id, table.key)]
);

export const bookTasks = sqliteTable('book_tasks', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	book_id: integer('book_id')
		.notNull()
		.references(() => books.id, { onDelete: 'cascade' }),
	chapter_id: integer('chapter_id').references(() => chapters.id, { onDelete: 'cascade' }),
	content: text('content').notNull(),
	status: text('status').notNull().default('open'),
	source: text('source').notNull().default('user'),
	created_at: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	updated_at: text('updated_at')
		.notNull()
		.default(sql`(datetime('now'))`)
});
