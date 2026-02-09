CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);

CREATE TABLE `books` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`user_id` integer NOT NULL REFERENCES `users`(`id`),
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE `chapters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer NOT NULL REFERENCES `books`(`id`) ON DELETE CASCADE,
	`title` text NOT NULL,
	`position` integer NOT NULL,
	`outline` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE `paragraphs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chapter_id` integer NOT NULL REFERENCES `chapters`(`id`) ON DELETE CASCADE,
	`content` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer NOT NULL REFERENCES `books`(`id`) ON DELETE CASCADE,
	`transcript` text,
	`summary` text,
	`mode` text DEFAULT 'conversation' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL REFERENCES `sessions`(`id`) ON DELETE CASCADE,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE `project_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer NOT NULL REFERENCES `books`(`id`) ON DELETE CASCADE,
	`key` text NOT NULL,
	`value` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
CREATE UNIQUE INDEX `project_notes_book_id_key_unique` ON `project_notes` (`book_id`, `key`);

CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer NOT NULL REFERENCES `books`(`id`) ON DELETE CASCADE,
	`session_id` integer REFERENCES `sessions`(`id`),
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer,
	`before_state` text,
	`after_state` text,
	`chat_snapshot` text,
	`source` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);

CREATE TABLE `book_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer NOT NULL REFERENCES `books`(`id`) ON DELETE CASCADE,
	`chapter_id` integer REFERENCES `chapters`(`id`) ON DELETE CASCADE,
	`content` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`source` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);

-- Seed data: users and default books
INSERT INTO `users` (`username`, `display_name`) VALUES ('jackie', 'Jackie');
INSERT INTO `users` (`username`, `display_name`) VALUES ('jonathan', 'Jonathan');

INSERT INTO `books` (`title`, `description`, `user_id`) VALUES ('My Book', NULL, 1);
INSERT INTO `books` (`title`, `description`, `user_id`) VALUES ('My Book', NULL, 2);

INSERT INTO `chapters` (`book_id`, `title`, `position`) VALUES (1, 'Introduction', 1);
INSERT INTO `chapters` (`book_id`, `title`, `position`) VALUES (2, 'Introduction', 1);

INSERT INTO `sessions` (`book_id`, `mode`) VALUES (1, 'conversation');
INSERT INTO `sessions` (`book_id`, `mode`) VALUES (2, 'conversation');
