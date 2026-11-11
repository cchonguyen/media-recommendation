CREATE TABLE `activity_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` text,
	`item_title_snapshot` text NOT NULL,
	`media_type` text NOT NULL,
	`event_type` text NOT NULL,
	`old_value` text,
	`new_value` text,
	`day_of_week_pt` integer NOT NULL,
	`hour_of_day_pt` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `media_items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_activity_log_item_id` ON `activity_log` (`item_id`);--> statement-breakpoint
CREATE INDEX `idx_activity_log_created_at` ON `activity_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `curated_list_items` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`media_item_id` text NOT NULL,
	`rank` integer NOT NULL,
	`blurb` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `curated_lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_item_id`) REFERENCES `media_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_curated_list_items_list_rank` ON `curated_list_items` (`list_id`,`rank`);--> statement-breakpoint
CREATE TABLE `curated_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`media_type_filter` text,
	`is_public` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_curated_lists_slug` ON `curated_lists` (`slug`);--> statement-breakpoint
CREATE TABLE `intake_log` (
	`line_hash` text PRIMARY KEY NOT NULL,
	`raw_line` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `media_items` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`raw_input` text NOT NULL,
	`year_hint` integer,
	`media_type` text NOT NULL,
	`status` text DEFAULT 'Backlog' NOT NULL,
	`enrichment_status` text DEFAULT 'PENDING' NOT NULL,
	`enrichment_attempts` integer DEFAULT 0 NOT NULL,
	`enrichment_error` text,
	`tmdb_id` text,
	`imdb_id` text,
	`igdb_id` text,
	`isbn13` text,
	`itunes_id` text,
	`source_url` text,
	`recommender_name` text DEFAULT 'Self' NOT NULL,
	`recommender_count` integer DEFAULT 1 NOT NULL,
	`trust_weight` integer DEFAULT 3 NOT NULL,
	`personal_notes` text DEFAULT '' NOT NULL,
	`my_rating` real,
	`personal_tier` text,
	`review_text` text DEFAULT '' NOT NULL,
	`review_done` integer DEFAULT false NOT NULL,
	`consumed_year` integer,
	`completed_at` text,
	`creator` text DEFAULT '' NOT NULL,
	`release_year` integer,
	`release_date` text,
	`release_state` text DEFAULT 'Unknown' NOT NULL,
	`release_access_display` text DEFAULT 'Unknown' NOT NULL,
	`streaming_providers_json` text DEFAULT '[]' NOT NULL,
	`genres_json` text DEFAULT '[]' NOT NULL,
	`is_available_now` integer DEFAULT false NOT NULL,
	`critic_score` real,
	`critic_score_display` text DEFAULT '' NOT NULL,
	`time_commitment_display` text DEFAULT '' NOT NULL,
	`time_commitment_minutes` integer,
	`amazon_link` text DEFAULT '' NOT NULL,
	`poster_image_url` text DEFAULT '' NOT NULL,
	`alternative_matches_note` text DEFAULT '' NOT NULL,
	`category_metadata_json` text DEFAULT '{}' NOT NULL,
	`priority_score` real DEFAULT 51 NOT NULL,
	`last_status_change_at` text NOT NULL,
	`last_enriched_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_media_items_status` ON `media_items` (`status`);--> statement-breakpoint
CREATE INDEX `idx_media_items_enrichment_status` ON `media_items` (`enrichment_status`);--> statement-breakpoint
CREATE INDEX `idx_media_items_media_type` ON `media_items` (`media_type`);--> statement-breakpoint
CREATE INDEX `idx_media_items_priority_score` ON `media_items` (`priority_score`);--> statement-breakpoint
CREATE INDEX `idx_media_items_release_year` ON `media_items` (`release_year`);--> statement-breakpoint
CREATE INDEX `idx_media_items_consumed_year` ON `media_items` (`consumed_year`);--> statement-breakpoint
CREATE TABLE `system_kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL
);
