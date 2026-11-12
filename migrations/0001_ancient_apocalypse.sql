CREATE TABLE `sweep_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`trigger` text NOT NULL,
	`outcome` text NOT NULL,
	`stage` text,
	`lines_seen` integer DEFAULT 0 NOT NULL,
	`created` integer DEFAULT 0 NOT NULL,
	`merged` integer DEFAULT 0 NOT NULL,
	`duplicates` integer DEFAULT 0 NOT NULL,
	`kept_in_doc` integer DEFAULT 0 NOT NULL,
	`rejected` integer DEFAULT 0 NOT NULL,
	`cleared` integer DEFAULT false NOT NULL,
	`error` text,
	`diag` text
);
