CREATE TYPE "public"."module_name" AS ENUM('moderation', 'automod', 'security', 'tickets', 'giveaways', 'applications', 'reports', 'appeals', 'roles', 'temporaryVoice', 'leveling', 'economy', 'welcome', 'inviteRewards', 'honeypot', 'logging', 'ai', 'utility', 'afk');--> statement-breakpoint
CREATE TYPE "public"."jail_status" AS ENUM('ACTIVE', 'EXPIRED', 'RELEASED', 'RECOVERY_REQUIRED');--> statement-breakpoint
CREATE TYPE "public"."mod_case_status" AS ENUM('OPEN', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."mod_case_type" AS ENUM('WARN', 'MUTE', 'UNMUTE', 'KICK', 'BAN', 'SOFTBAN', 'JAIL', 'UNJAIL', 'PURGE');--> statement-breakpoint
CREATE TYPE "public"."reward_source" AS ENUM('LEVEL', 'INVITE', 'GIVEAWAY', 'APPLICATION', 'SHOP');--> statement-breakpoint
CREATE TYPE "public"."reward_status" AS ENUM('PENDING', 'DELIVERED', 'FAILED', 'RECOVERING', 'FAILED_FINAL', 'BLOCKED');--> statement-breakpoint
CREATE TYPE "public"."reward_type" AS ENUM('CURRENCY', 'ROLE', 'ITEM');--> statement-breakpoint
CREATE TYPE "public"."season_status" AS ENUM('ACTIVE', 'FINALIZED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."economy_transaction_type" AS ENUM('DAILY_REWARD', 'WORK_REWARD', 'QUEST_REWARD', 'LEVEL_REWARD', 'STAFF_GRANT', 'ROLE_PURCHASE', 'SHOP_PURCHASE', 'USER_TRANSFER', 'REFUND', 'ADMIN_ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."afk_notification_status" AS ENUM('ACTIVE', 'NOTIFIED', 'CANCELLED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."afk_delivery_status" AS ENUM('PENDING', 'DELIVERED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."afk_period_status" AS ENUM('ACTIVE', 'RETURNED', 'FINALIZED');--> statement-breakpoint
CREATE TYPE "public"."afk_return_action_status" AS ENUM('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED', 'FAILED_FINAL');--> statement-breakpoint
CREATE TYPE "public"."afk_status" AS ENUM('CLEAR', 'AFK');--> statement-breakpoint
CREATE TYPE "public"."attribution_state" AS ENUM('CONFIRMED', 'PROBABLE', 'UNKNOWN', 'UNAVAILABLE');--> statement-breakpoint
CREATE TYPE "public"."automod_mode" AS ENUM('ACTIVE', 'DRY_RUN', 'DISABLED');--> statement-breakpoint
CREATE TYPE "public"."confidence" AS ENUM('HIGH', 'MEDIUM', 'LOW');--> statement-breakpoint
CREATE TYPE "public"."strike_decay_mode" AS ENUM('NONE', 'FIXED_WINDOW', 'ROLLING_WINDOW');--> statement-breakpoint
CREATE TYPE "public"."operation_status" AS ENUM('AUTHORIZED', 'RUNNING', 'COMPLETED', 'ABORTED', 'OWNER_AUTHORIZATION_LOST');--> statement-breakpoint
CREATE TYPE "public"."policy_effect" AS ENUM('SKIP', 'QUIET', 'ALLOW');--> statement-breakpoint
CREATE TYPE "public"."policy_subject" AS ENUM('USER', 'ROLE', 'CHANNEL', 'CATEGORY');--> statement-breakpoint
CREATE TYPE "public"."ticket_priority" AS ENUM('LOW', 'NORMAL', 'HIGH', 'URGENT');--> statement-breakpoint
CREATE TYPE "public"."ticket_state" AS ENUM('OPEN', 'CLAIMED', 'WAITING_FOR_USER', 'WAITING_FOR_STAFF', 'CLOSED', 'REOPENED');--> statement-breakpoint
CREATE TABLE "guild_members" (
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_members_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "guild_modules" (
	"guild_id" bigint NOT NULL,
	"module" "module_name" NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_modules_guild_id_module_pk" PRIMARY KEY("guild_id","module")
);
--> statement-breakpoint
CREATE TABLE "guild_settings" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"accent" text DEFAULT 'azure' NOT NULL,
	"server_icon_url" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guilds" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_id" bigint NOT NULL,
	"locale" text DEFAULT 'en-US',
	"shard" integer,
	"active" boolean DEFAULT true NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "i18n_strings" (
	"locale" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "i18n_strings_locale_key_pk" PRIMARY KEY("locale","key")
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "prefixes" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"prefix" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schema_migrations" (
	"version" text PRIMARY KEY NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigint PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "blacklist_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"reason" text,
	"created_by" bigint NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"case_id" uuid,
	"jail_role_id" bigint,
	"jail_channel_id" bigint,
	"captured_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"captured_managed_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inaccessible_channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"reason" text,
	"status" "jail_status" DEFAULT 'ACTIVE' NOT NULL,
	"operation_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"chain_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"supersedes_operation_id" uuid,
	"partial_restore_reason" text,
	"missing_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_action_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"action" text NOT NULL,
	"actor_id" bigint NOT NULL,
	"target_id" bigint,
	"case_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_case_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"event" text NOT NULL,
	"actor_id" bigint,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_case_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"content" text,
	"url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"case_number" integer NOT NULL,
	"type" "mod_case_type" NOT NULL,
	"status" "mod_case_status" DEFAULT 'OPEN' NOT NULL,
	"target_id" bigint NOT NULL,
	"moderator_id" bigint NOT NULL,
	"reason" text,
	"duration_seconds" integer,
	"expires_at" timestamp with time zone,
	"locked_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mutes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"case_id" uuid,
	"reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"completed_at" timestamp with time zone,
	"created_by" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purge_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"actor_id" bigint NOT NULL,
	"channel_id" bigint NOT NULL,
	"count" integer NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"note" text NOT NULL,
	"author_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"case_id" uuid,
	"reason" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "economy_daily_claims" (
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"claim_date" text NOT NULL,
	"streak" integer DEFAULT 1 NOT NULL,
	"reward" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "economy_daily_claims_guild_id_user_id_claim_date_pk" PRIMARY KEY("guild_id","user_id","claim_date")
);
--> statement-breakpoint
CREATE TABLE "economy_inventory" (
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "economy_inventory_guild_id_user_id_item_id_pk" PRIMARY KEY("guild_id","user_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "economy_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"role_id" bigint,
	"name" text NOT NULL,
	"description" text,
	"icon" text
);
--> statement-breakpoint
CREATE TABLE "economy_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"shop_item_id" uuid NOT NULL,
	"transaction_id" uuid,
	"amount" bigint NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "economy_quest_progress" (
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"quest_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "economy_quest_progress_guild_id_user_id_quest_id_period_key_pk" PRIMARY KEY("guild_id","user_id","quest_id","period_key")
);
--> statement-breakpoint
CREATE TABLE "economy_quests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"reward" bigint NOT NULL,
	"period" text DEFAULT 'ONCE' NOT NULL,
	"active" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "economy_recovery_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"purchase_id" uuid,
	"transaction_id" uuid,
	"shop_item_id" uuid,
	"failure_type" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"original_amount" bigint,
	"compensated_amount" bigint,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "economy_shop_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"item_id" uuid NOT NULL,
	"price" bigint NOT NULL,
	"description" text,
	"group_name" text,
	"stock" integer,
	"cooldown_seconds" integer,
	"max_purchases" integer,
	"duration_seconds" integer,
	"repeat_purchasable" integer DEFAULT 0 NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "economy_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"amount" bigint NOT NULL,
	"type" "economy_transaction_type" NOT NULL,
	"source" text,
	"destination_id" bigint,
	"reference_id" text,
	"balance_before" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"actor_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "economy_wallets" (
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"lifetime_earned" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "economy_wallets_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "economy_work_cooldowns" (
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"last_worked_at" timestamp with time zone,
	CONSTRAINT "economy_work_cooldowns_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "guild_currency" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"name" text DEFAULT 'Coins' NOT NULL,
	"symbol" text DEFAULT '◈' NOT NULL,
	"grant_ceiling" bigint
);
--> statement-breakpoint
CREATE TABLE "level_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"season_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"source" text NOT NULL,
	"channel_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "level_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"season_id" uuid NOT NULL,
	"season_xp" bigint DEFAULT 0 NOT NULL,
	"level" integer DEFAULT 0 NOT NULL,
	"xp_in_level" integer DEFAULT 0 NOT NULL,
	"lifetime_xp" bigint DEFAULT 0 NOT NULL,
	"last_xp_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "level_reward_recovery_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"reward_id" uuid NOT NULL,
	"reward_type" "reward_type" NOT NULL,
	"failure_type" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "level_rewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"level" integer NOT NULL,
	"type" "reward_type" NOT NULL,
	"role_id" bigint,
	"amount" bigint,
	"item_id" uuid,
	"icon" text,
	"description" text,
	"active" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "level_rewards_granted" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"reward_id" uuid NOT NULL,
	"season_id" uuid NOT NULL,
	"status" "reward_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "level_settings" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"curve" text DEFAULT 'LINEAR' NOT NULL,
	"curve_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"min_message_length" integer DEFAULT 12 NOT NULL,
	"min_interval_seconds" integer DEFAULT 20 NOT NULL,
	"per_message_clamp" integer DEFAULT 25 NOT NULL,
	"rate_cap_minutes" integer DEFAULT 30 NOT NULL,
	"rate_cap_xp" integer DEFAULT 200 NOT NULL,
	"starting_level" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reward_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"source" "reward_source" NOT NULL,
	"source_id" uuid NOT NULL,
	"reward_id" uuid NOT NULL,
	"reward_type" "reward_type" NOT NULL,
	"amount" bigint,
	"role_id" bigint,
	"status" "reward_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "role_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"item_id" uuid NOT NULL,
	"role_id" bigint,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"active" integer DEFAULT 1 NOT NULL,
	"deactivated_at" timestamp with time zone,
	"deactivated_reason" text,
	"source_purchase_id" uuid
);
--> statement-breakpoint
CREATE TABLE "season_leaderboards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season_id" uuid NOT NULL,
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"final_rank" integer NOT NULL,
	"final_xp" bigint NOT NULL,
	"final_level" integer NOT NULL,
	"rewards_granted" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"finalized_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"status" "season_status" DEFAULT 'ACTIVE' NOT NULL,
	"finalized_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "afk_back_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"afk_user_id" bigint NOT NULL,
	"subscriber_id" bigint NOT NULL,
	"afk_period_id" uuid NOT NULL,
	"status" "afk_notification_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "afk_ignored_channels" (
	"guild_id" bigint NOT NULL,
	"channel_id" bigint NOT NULL,
	"clears_own_afk" boolean DEFAULT true NOT NULL,
	CONSTRAINT "afk_ignored_channels_guild_id_channel_id_pk" PRIMARY KEY("guild_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "afk_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"afk_user_id" bigint NOT NULL,
	"afk_period_id" uuid NOT NULL,
	"sender_id" bigint NOT NULL,
	"message" text NOT NULL,
	"delivery_status" "afk_delivery_status" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "afk_return_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"afk_period_id" uuid NOT NULL,
	"action_type" text DEFAULT 'RETURN_ANNOUNCEMENT' NOT NULL,
	"status" "afk_return_action_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "afk_settings" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"default_message" text DEFAULT 'Away from keyboard' NOT NULL,
	"notices_enabled" boolean DEFAULT true NOT NULL,
	"return_announcement_enabled" boolean DEFAULT false NOT NULL,
	"return_announcement_channel_id" bigint,
	"show_reason" boolean DEFAULT true NOT NULL,
	"leave_message_enabled" boolean DEFAULT true NOT NULL,
	"back_notification_enabled" boolean DEFAULT true NOT NULL,
	"notice_cooldown_seconds" integer DEFAULT 30 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "afk_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"afk_period_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "afk_status" DEFAULT 'CLEAR' NOT NULL,
	"period_status" "afk_period_status" DEFAULT 'FINALIZED' NOT NULL,
	"returned_at" timestamp with time zone,
	"cleared_at" timestamp with time zone,
	"cleared_by" bigint,
	"clear_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automod_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"rule_id" uuid NOT NULL,
	"user_id" bigint NOT NULL,
	"channel_id" bigint,
	"message_id" bigint,
	"confidence" "confidence" NOT NULL,
	"severity" integer DEFAULT 1 NOT NULL,
	"match_source" text DEFAULT 'ORIGINAL' NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"action_taken" text,
	"would_have" text,
	"result" text NOT NULL,
	"rule_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automod_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"name" text NOT NULL,
	"trigger_type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"mode" "automod_mode" DEFAULT 'ACTIVE' NOT NULL,
	"min_confidence" "confidence" DEFAULT 'MEDIUM' NOT NULL,
	"escalation" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rule_aware" boolean DEFAULT true NOT NULL,
	"strike_decay_mode" "strike_decay_mode" DEFAULT 'ROLLING_WINDOW' NOT NULL,
	"window_seconds" integer DEFAULT 1800,
	"decay_seconds" integer,
	"action_state" text DEFAULT 'OK' NOT NULL,
	"error_reason" text,
	"created_by" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automod_strikes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"rule_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"decay_mode" "strike_decay_mode" DEFAULT 'ROLLING_WINDOW' NOT NULL,
	"window_seconds" integer DEFAULT 1800,
	"active" boolean DEFAULT true NOT NULL,
	"rule_aware" boolean DEFAULT true NOT NULL,
	"escalation_level" integer DEFAULT 0 NOT NULL,
	"action_applied" text,
	"case_id" uuid,
	"expired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"label" text NOT NULL,
	"schema_version" text NOT NULL,
	"payload" jsonb NOT NULL,
	"checksum" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "giveaway_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"giveaway_id" uuid NOT NULL,
	"user_id" bigint NOT NULL,
	"evidence" text,
	"recommended_outcome" text,
	"staff_decision" text,
	"decided_by" bigint,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "giveaway_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"giveaway_id" uuid NOT NULL,
	"user_id" bigint NOT NULL,
	"entry_count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "giveaway_rerolls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"giveaway_id" uuid NOT NULL,
	"winner_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"entry_count" integer NOT NULL,
	"actor_id" bigint,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "giveaways" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"channel_id" bigint NOT NULL,
	"message_id" bigint,
	"prize" text NOT NULL,
	"winner_count" integer DEFAULT 1 NOT NULL,
	"minimum_role_id" bigint,
	"ends_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_by" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite_counters" (
	"guild_id" bigint NOT NULL,
	"inviter_id" bigint NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"current" integer DEFAULT 0 NOT NULL,
	"left" integer DEFAULT 0 NOT NULL,
	"rejoins" integer DEFAULT 0 NOT NULL,
	"ineligible" integer DEFAULT 0 NOT NULL,
	"reward_eligible" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_counters_guild_id_inviter_id_pk" PRIMARY KEY("guild_id","inviter_id")
);
--> statement-breakpoint
CREATE TABLE "invite_joins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"invite_code" text,
	"inviter_id" bigint,
	"attribution" "attribution_state" DEFAULT 'UNKNOWN' NOT NULL,
	"source" text DEFAULT 'NORMAL' NOT NULL,
	"is_bot" boolean DEFAULT false NOT NULL,
	"is_rejoin" boolean DEFAULT false NOT NULL,
	"eligible" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invite_reward_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"threshold" integer NOT NULL,
	"reward_type" text NOT NULL,
	"role_id" bigint,
	"amount" bigint,
	"item_id" uuid,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"invite_code" text NOT NULL,
	"channel_id" bigint,
	"inviter_id" bigint,
	"uses" integer DEFAULT 0 NOT NULL,
	"max_uses" integer,
	"temporary" boolean DEFAULT false NOT NULL,
	"snapshot_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "log_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"event_type" text NOT NULL,
	"channel_id" bigint NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "log_settings" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"ignored_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ignored_channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ignored_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"retention_days" integer DEFAULT 30
);
--> statement-breakpoint
CREATE TABLE "operation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"guild_id" bigint NOT NULL,
	"actor_id" bigint NOT NULL,
	"current_owner_id" bigint,
	"resource_id" uuid,
	"event" text NOT NULL,
	"result" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reference_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"operation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"initiating_owner_id" bigint NOT NULL,
	"current_executor_id" bigint,
	"current_owner_id" bigint,
	"status" "operation_status" DEFAULT 'AUTHORIZED' NOT NULL,
	"backup_id" uuid,
	"template_id" uuid,
	"reference_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"domain" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"subject" "policy_subject" NOT NULL,
	"subject_id" text NOT NULL,
	"rule_scope" text,
	"effect" "policy_effect" DEFAULT 'SKIP' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_panel_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"panel_id" uuid NOT NULL,
	"role_id" bigint NOT NULL,
	"label" text NOT NULL,
	"emoji" text,
	"group_name" text,
	"removable" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_panels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"channel_id" bigint NOT NULL,
	"message_id" bigint,
	"title" text,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint,
	"name" text NOT NULL,
	"description" text,
	"schema_version" text NOT NULL,
	"payload" jsonb NOT NULL,
	"source_template_id" uuid,
	"created_by" bigint NOT NULL,
	"checksum" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_ai_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"content" text NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_auto_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"ticket_type_id" uuid,
	"match_type" text NOT NULL,
	"pattern" text NOT NULL,
	"reply" text NOT NULL,
	"channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cooldown_seconds" integer,
	"max_per_ticket" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_members" (
	"ticket_id" uuid NOT NULL,
	"user_id" bigint NOT NULL,
	"is_staff" boolean DEFAULT false NOT NULL,
	CONSTRAINT "ticket_members_ticket_id_user_id_pk" PRIMARY KEY("ticket_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "ticket_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_id" bigint NOT NULL,
	"note" text NOT NULL,
	"internal" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_panels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"channel_id" bigint NOT NULL,
	"message_id" bigint,
	"type_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category_id" bigint,
	"staff_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"form_id" uuid,
	"sla_minutes" integer,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"ticket_type_id" uuid,
	"channel_id" bigint NOT NULL,
	"requester_id" bigint NOT NULL,
	"category_id" bigint,
	"state" "ticket_state" DEFAULT 'OPEN' NOT NULL,
	"priority" "ticket_priority" DEFAULT 'NORMAL' NOT NULL,
	"assigned_to" bigint,
	"subject" text,
	"form_answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sla_due_at" timestamp with time zone,
	"satisfaction" integer,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guild_members" ADD CONSTRAINT "guild_members_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_members" ADD CONSTRAINT "guild_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_modules" ADD CONSTRAINT "guild_modules_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD CONSTRAINT "guild_settings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prefixes" ADD CONSTRAINT "prefixes_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blacklist_entries" ADD CONSTRAINT "blacklist_entries_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jails" ADD CONSTRAINT "jails_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jails" ADD CONSTRAINT "jails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jails" ADD CONSTRAINT "jails_case_id_mod_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."mod_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mod_action_log" ADD CONSTRAINT "mod_action_log_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mod_case_events" ADD CONSTRAINT "mod_case_events_case_id_mod_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."mod_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mod_case_evidence" ADD CONSTRAINT "mod_case_evidence_case_id_mod_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."mod_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mod_cases" ADD CONSTRAINT "mod_cases_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mod_cases" ADD CONSTRAINT "mod_cases_target_id_users_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mod_cases" ADD CONSTRAINT "mod_cases_moderator_id_users_id_fk" FOREIGN KEY ("moderator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mutes" ADD CONSTRAINT "mutes_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mutes" ADD CONSTRAINT "mutes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mutes" ADD CONSTRAINT "mutes_case_id_mod_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."mod_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purge_audit" ADD CONSTRAINT "purge_audit_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_notes" ADD CONSTRAINT "staff_notes_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_notes" ADD CONSTRAINT "staff_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warnings" ADD CONSTRAINT "warnings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warnings" ADD CONSTRAINT "warnings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warnings" ADD CONSTRAINT "warnings_case_id_mod_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."mod_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_daily_claims" ADD CONSTRAINT "economy_daily_claims_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_daily_claims" ADD CONSTRAINT "economy_daily_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_inventory" ADD CONSTRAINT "economy_inventory_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_inventory" ADD CONSTRAINT "economy_inventory_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_inventory" ADD CONSTRAINT "economy_inventory_item_id_economy_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."economy_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_items" ADD CONSTRAINT "economy_items_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_purchases" ADD CONSTRAINT "economy_purchases_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_purchases" ADD CONSTRAINT "economy_purchases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_purchases" ADD CONSTRAINT "economy_purchases_shop_item_id_economy_shop_items_id_fk" FOREIGN KEY ("shop_item_id") REFERENCES "public"."economy_shop_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_quest_progress" ADD CONSTRAINT "economy_quest_progress_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_quest_progress" ADD CONSTRAINT "economy_quest_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_quest_progress" ADD CONSTRAINT "economy_quest_progress_quest_id_economy_quests_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."economy_quests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_quests" ADD CONSTRAINT "economy_quests_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_recovery_events" ADD CONSTRAINT "economy_recovery_events_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_recovery_events" ADD CONSTRAINT "economy_recovery_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_shop_items" ADD CONSTRAINT "economy_shop_items_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_shop_items" ADD CONSTRAINT "economy_shop_items_item_id_economy_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."economy_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_transactions" ADD CONSTRAINT "economy_transactions_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_transactions" ADD CONSTRAINT "economy_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_wallets" ADD CONSTRAINT "economy_wallets_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_wallets" ADD CONSTRAINT "economy_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_work_cooldowns" ADD CONSTRAINT "economy_work_cooldowns_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_work_cooldowns" ADD CONSTRAINT "economy_work_cooldowns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_currency" ADD CONSTRAINT "guild_currency_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "level_profiles" ADD CONSTRAINT "level_profiles_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "level_profiles" ADD CONSTRAINT "level_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "level_reward_recovery_events" ADD CONSTRAINT "level_reward_recovery_events_grant_id_level_rewards_granted_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."level_rewards_granted"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "level_rewards" ADD CONSTRAINT "level_rewards_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "level_rewards_granted" ADD CONSTRAINT "level_rewards_granted_reward_id_level_rewards_id_fk" FOREIGN KEY ("reward_id") REFERENCES "public"."level_rewards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "level_settings" ADD CONSTRAINT "level_settings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_deliveries" ADD CONSTRAINT "reward_deliveries_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_deliveries" ADD CONSTRAINT "reward_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_purchases" ADD CONSTRAINT "role_purchases_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_purchases" ADD CONSTRAINT "role_purchases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_purchases" ADD CONSTRAINT "role_purchases_item_id_economy_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."economy_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_leaderboards" ADD CONSTRAINT "season_leaderboards_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "afk_ignored_channels" ADD CONSTRAINT "afk_ignored_channels_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "afk_settings" ADD CONSTRAINT "afk_settings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "afk_status" ADD CONSTRAINT "afk_status_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "afk_status" ADD CONSTRAINT "afk_status_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automod_events" ADD CONSTRAINT "automod_events_rule_id_automod_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."automod_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automod_rules" ADD CONSTRAINT "automod_rules_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giveaway_claims" ADD CONSTRAINT "giveaway_claims_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giveaway_entries" ADD CONSTRAINT "giveaway_entries_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giveaway_rerolls" ADD CONSTRAINT "giveaway_rerolls_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giveaways" ADD CONSTRAINT "giveaways_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_counters" ADD CONSTRAINT "invite_counters_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_joins" ADD CONSTRAINT "invite_joins_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_reward_rules" ADD CONSTRAINT "invite_reward_rules_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_snapshots" ADD CONSTRAINT "invite_snapshots_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_channels" ADD CONSTRAINT "log_channels_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_settings" ADD CONSTRAINT "log_settings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_events" ADD CONSTRAINT "operation_events_operation_id_operations_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."operations"("operation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_rules" ADD CONSTRAINT "policy_rules_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_panel_options" ADD CONSTRAINT "role_panel_options_panel_id_role_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "public"."role_panels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_panels" ADD CONSTRAINT "role_panels_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_ai_replies" ADD CONSTRAINT "ticket_ai_replies_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_auto_replies" ADD CONSTRAINT "ticket_auto_replies_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_members" ADD CONSTRAINT "ticket_members_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_notes" ADD CONSTRAINT "ticket_notes_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_panels" ADD CONSTRAINT "ticket_panels_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_types" ADD CONSTRAINT "ticket_types_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guild_members_guild_idx" ON "guild_members" USING btree ("guild_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_runs_name_key_unique" ON "job_runs" USING btree ("job_name","idempotency_key");--> statement-breakpoint
CREATE INDEX "job_runs_status_idx" ON "job_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "prefixes_guild_unique" ON "prefixes" USING btree ("guild_id");--> statement-breakpoint
CREATE UNIQUE INDEX "blacklist_guild_user_unique" ON "blacklist_entries" USING btree ("guild_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jails_guild_user_active_unique" ON "jails" USING btree ("guild_id","user_id") WHERE "jails"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "jails_chain_idx" ON "jails" USING btree ("chain_id");--> statement-breakpoint
CREATE INDEX "jails_expiry_idx" ON "jails" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "mod_action_log_guild_idx" ON "mod_action_log" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "mod_case_events_case_idx" ON "mod_case_events" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "mod_case_evidence_case_idx" ON "mod_case_evidence" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mod_cases_guild_number_unique" ON "mod_cases" USING btree ("guild_id","case_number");--> statement-breakpoint
CREATE INDEX "mod_cases_guild_idx" ON "mod_cases" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "mod_cases_target_idx" ON "mod_cases" USING btree ("guild_id","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mutes_guild_user_active_unique" ON "mutes" USING btree ("guild_id","user_id") WHERE "mutes"."active" = true;--> statement-breakpoint
CREATE INDEX "mutes_expiry_idx" ON "mutes" USING btree ("active","expires_at");--> statement-breakpoint
CREATE INDEX "purge_audit_guild_idx" ON "purge_audit" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "staff_notes_guild_user_idx" ON "staff_notes" USING btree ("guild_id","user_id");--> statement-breakpoint
CREATE INDEX "warnings_guild_user_idx" ON "warnings" USING btree ("guild_id","user_id");--> statement-breakpoint
CREATE INDEX "economy_items_guild_idx" ON "economy_items" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "economy_purchases_pending_idx" ON "economy_purchases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "economy_purchases_guild_user_idx" ON "economy_purchases" USING btree ("guild_id","user_id");--> statement-breakpoint
CREATE INDEX "economy_quests_guild_idx" ON "economy_quests" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "economy_recovery_open_idx" ON "economy_recovery_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "economy_recovery_guild_idx" ON "economy_recovery_events" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "economy_shop_items_guild_idx" ON "economy_shop_items" USING btree ("guild_id","active");--> statement-breakpoint
CREATE INDEX "economy_shop_items_item_idx" ON "economy_shop_items" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "economy_tx_guild_user_idx" ON "economy_transactions" USING btree ("guild_id","user_id");--> statement-breakpoint
CREATE INDEX "economy_tx_type_idx" ON "economy_transactions" USING btree ("type");--> statement-breakpoint
CREATE INDEX "economy_wallets_guild_idx" ON "economy_wallets" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "level_events_user_idx" ON "level_events" USING btree ("guild_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "level_profiles_unique" ON "level_profiles" USING btree ("guild_id","user_id","season_id");--> statement-breakpoint
CREATE INDEX "level_profiles_guild_idx" ON "level_profiles" USING btree ("guild_id","season_id");--> statement-breakpoint
CREATE INDEX "level_reward_recovery_open_idx" ON "level_reward_recovery_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "level_rewards_level_idx" ON "level_rewards" USING btree ("guild_id","level");--> statement-breakpoint
CREATE UNIQUE INDEX "level_rewards_granted_unique" ON "level_rewards_granted" USING btree ("guild_id","user_id","reward_id","season_id");--> statement-breakpoint
CREATE INDEX "level_rewards_granted_status_idx" ON "level_rewards_granted" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "reward_deliveries_unique" ON "reward_deliveries" USING btree ("guild_id","user_id","source","source_id","reward_id");--> statement-breakpoint
CREATE INDEX "reward_deliveries_status_idx" ON "reward_deliveries" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "role_purchases_active_unique" ON "role_purchases" USING btree ("guild_id","user_id","item_id") WHERE "role_purchases"."active" = 1;--> statement-breakpoint
CREATE INDEX "role_purchases_expiry_idx" ON "role_purchases" USING btree ("active","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "season_leaderboards_unique" ON "season_leaderboards" USING btree ("season_id","user_id");--> statement-breakpoint
CREATE INDEX "season_leaderboards_rank_idx" ON "season_leaderboards" USING btree ("season_id","final_rank");--> statement-breakpoint
CREATE INDEX "seasons_active_idx" ON "seasons" USING btree ("guild_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "afk_back_notifications_unique" ON "afk_back_notifications" USING btree ("guild_id","afk_user_id","subscriber_id","afk_period_id");--> statement-breakpoint
CREATE INDEX "afk_back_notifications_active_idx" ON "afk_back_notifications" USING btree ("guild_id","afk_period_id") WHERE "afk_back_notifications"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "afk_messages_pending_idx" ON "afk_messages" USING btree ("guild_id","afk_period_id") WHERE "afk_messages"."delivery_status" = 'PENDING';--> statement-breakpoint
CREATE UNIQUE INDEX "afk_return_actions_unique" ON "afk_return_actions" USING btree ("guild_id","afk_period_id","action_type");--> statement-breakpoint
CREATE INDEX "afk_return_actions_recovery_idx" ON "afk_return_actions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "afk_status_period_unique" ON "afk_status" USING btree ("afk_period_id");--> statement-breakpoint
CREATE UNIQUE INDEX "afk_status_guild_period_unique" ON "afk_status" USING btree ("guild_id","afk_period_id");--> statement-breakpoint
CREATE UNIQUE INDEX "afk_status_active_unique" ON "afk_status" USING btree ("guild_id","user_id") WHERE "afk_status"."status" = 'AFK';--> statement-breakpoint
CREATE INDEX "afk_status_hot_idx" ON "afk_status" USING btree ("guild_id","user_id","status");--> statement-breakpoint
CREATE INDEX "automod_events_rule_idx" ON "automod_events" USING btree ("guild_id","rule_id","created_at");--> statement-breakpoint
CREATE INDEX "automod_events_user_idx" ON "automod_events" USING btree ("guild_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "automod_rules_guild_idx" ON "automod_rules" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "automod_strikes_escalate_idx" ON "automod_strikes" USING btree ("guild_id","user_id","rule_id");--> statement-breakpoint
CREATE INDEX "backups_guild_idx" ON "backups" USING btree ("guild_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "giveaway_claims_unique" ON "giveaway_claims" USING btree ("giveaway_id","user_id");--> statement-breakpoint
CREATE INDEX "giveaway_claims_pending_idx" ON "giveaway_claims" USING btree ("giveaway_id") WHERE "giveaway_claims"."staff_decision" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "giveaway_entries_unique" ON "giveaway_entries" USING btree ("giveaway_id","user_id");--> statement-breakpoint
CREATE INDEX "giveaway_rerolls_giveaway_idx" ON "giveaway_rerolls" USING btree ("giveaway_id");--> statement-breakpoint
CREATE INDEX "giveaways_guild_idx" ON "giveaways" USING btree ("guild_id","status");--> statement-breakpoint
CREATE INDEX "invite_joins_guild_idx" ON "invite_joins" USING btree ("guild_id","joined_at");--> statement-breakpoint
CREATE INDEX "invite_joins_inviter_idx" ON "invite_joins" USING btree ("guild_id","inviter_id");--> statement-breakpoint
CREATE INDEX "invite_reward_rules_guild_idx" ON "invite_reward_rules" USING btree ("guild_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_snapshots_code_unique" ON "invite_snapshots" USING btree ("guild_id","invite_code");--> statement-breakpoint
CREATE UNIQUE INDEX "log_channels_event_unique" ON "log_channels" USING btree ("guild_id","event_type");--> statement-breakpoint
CREATE INDEX "operation_events_op_idx" ON "operation_events" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "operations_guild_idx" ON "operations" USING btree ("guild_id","started_at");--> statement-breakpoint
CREATE INDEX "operations_status_idx" ON "operations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "policies_guild_domain_idx" ON "policies" USING btree ("guild_id","domain");--> statement-breakpoint
CREATE INDEX "policy_rules_policy_idx" ON "policy_rules" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX "role_panel_options_panel_idx" ON "role_panel_options" USING btree ("panel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_panels_channel_unique" ON "role_panels" USING btree ("guild_id","channel_id");--> statement-breakpoint
CREATE INDEX "templates_guild_idx" ON "templates" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "ticket_ai_replies_ticket_idx" ON "ticket_ai_replies" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "ticket_auto_replies_guild_idx" ON "ticket_auto_replies" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "ticket_notes_ticket_idx" ON "ticket_notes" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_panels_channel_unique" ON "ticket_panels" USING btree ("guild_id","channel_id");--> statement-breakpoint
CREATE INDEX "ticket_types_guild_idx" ON "ticket_types" USING btree ("guild_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_channel_unique" ON "tickets" USING btree ("guild_id","channel_id");--> statement-breakpoint
CREATE INDEX "tickets_guild_state_idx" ON "tickets" USING btree ("guild_id","state");--> statement-breakpoint
CREATE INDEX "tickets_requester_idx" ON "tickets" USING btree ("guild_id","requester_id");