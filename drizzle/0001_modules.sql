CREATE TYPE "public"."ai_outcome" AS ENUM('ALLOWED', 'REFUSED', 'ERROR', 'SKIPPED_NO_KEY');--> statement-breakpoint
CREATE TYPE "public"."appeal_status" AS ENUM('OPEN', 'UNDER_REVIEW', 'APPROVED', 'DENIED');--> statement-breakpoint
CREATE TYPE "public"."application_status" AS ENUM('PENDING', 'APPROVED', 'DENIED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."honeypot_action" AS ENUM('LOG', 'MUTE', 'DELETE', 'KICK');--> statement-breakpoint
CREATE TYPE "public"."raid_mode_status" AS ENUM('INACTIVE', 'ON', 'LIMITED');--> statement-breakpoint
CREATE TYPE "public"."report_priority" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'URGENT');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('OPEN', 'REVIEWING', 'RESOLVED', 'DISMISSED');--> statement-breakpoint
CREATE TYPE "public"."setup_step" AS ENUM('START', 'MODULES', 'CHANNELS', 'ROLES', 'REVIEW', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."temp_voice_status" AS ENUM('ACTIVE', 'LOCKED', 'UNLOCKED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('PENDING', 'VERIFIED', 'REJECTED', 'BYPASSED');--> statement-breakpoint
CREATE TABLE "ai_circuit_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'CLOSED' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone,
	"next_probe_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"feature" text NOT NULL,
	"outcome" "ai_outcome" NOT NULL,
	"reason" text,
	"confidence" integer,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_settings" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"model" text,
	"max_daily_requests" integer,
	"auto_action_enabled" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_commands" (
	"guild_id" bigint NOT NULL,
	"command" text NOT NULL,
	"day" text NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "analytics_commands_guild_id_command_day_pk" PRIMARY KEY("guild_id","command","day")
);
--> statement-breakpoint
CREATE TABLE "analytics_daily" (
	"guild_id" bigint NOT NULL,
	"day" text NOT NULL,
	"messages" integer DEFAULT 0 NOT NULL,
	"active_members" integer DEFAULT 0 NOT NULL,
	"joins" integer DEFAULT 0 NOT NULL,
	"leaves" integer DEFAULT 0 NOT NULL,
	"actions" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_daily_guild_id_day_pk" PRIMARY KEY("guild_id","day")
);
--> statement-breakpoint
CREATE TABLE "appeals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"case_id" uuid,
	"statement" text NOT NULL,
	"status" "appeal_status" DEFAULT 'OPEN' NOT NULL,
	"reviewer_id" bigint,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "application_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"accept_role_id" bigint,
	"deny_role_id" bigint,
	"required" boolean DEFAULT false NOT NULL,
	"questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"log_channel_id" bigint,
	"active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"form_id" uuid NOT NULL,
	"answers" jsonb NOT NULL,
	"status" "application_status" DEFAULT 'PENDING' NOT NULL,
	"reviewer_id" bigint,
	"review_note" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auto_roles" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"channel_id" bigint,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "honeypot_channels" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"channel_id" bigint NOT NULL,
	"action" "honeypot_action" DEFAULT 'LOG' NOT NULL,
	"alert_channel_id" bigint,
	"reaction_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "honeypot_trips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"channel_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"action" "honeypot_action" NOT NULL,
	"message_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lockdown_state" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"channel_states" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"role_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"activated_by" bigint,
	"activated_at" timestamp with time zone,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "message_analytics" (
	"guild_id" bigint NOT NULL,
	"channel_id" bigint NOT NULL,
	"day" text NOT NULL,
	"messages" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "message_analytics_guild_id_channel_id_day_pk" PRIMARY KEY("guild_id","channel_id","day")
);
--> statement-breakpoint
CREATE TABLE "raid_mode" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"status" "raid_mode_status" DEFAULT 'INACTIVE' NOT NULL,
	"join_rate_threshold" integer DEFAULT 10 NOT NULL,
	"join_rate_window_seconds" integer DEFAULT 30 NOT NULL,
	"account_age_threshold_hours" integer DEFAULT 60 NOT NULL,
	"avatar_threshold_hours" integer DEFAULT 24 NOT NULL,
	"action" text DEFAULT 'MUTE' NOT NULL,
	"exempt_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"triggered_by" bigint,
	"triggered_at" timestamp with time zone,
	"cleared_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "report_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"report_id" uuid NOT NULL,
	"author_id" bigint NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"reporter_id" bigint NOT NULL,
	"target_user_id" bigint,
	"target_message_id" bigint,
	"reason" text NOT NULL,
	"details" text,
	"status" "report_status" DEFAULT 'OPEN' NOT NULL,
	"priority" "report_priority" DEFAULT 'LOW' NOT NULL,
	"assigned_to" bigint,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "search_documents" (
	"guild_id" bigint NOT NULL,
	"external_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"author_id" bigint,
	"channel_id" bigint,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_documents_guild_id_external_id_pk" PRIMARY KEY("guild_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "search_queries" (
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"query" text NOT NULL,
	"results" integer DEFAULT 0 NOT NULL,
	"query_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_settings" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"anti_raid_enabled" boolean DEFAULT false NOT NULL,
	"suspicious_invite_enabled" boolean DEFAULT false NOT NULL,
	"suspicious_invite_action" text DEFAULT 'MUTE' NOT NULL,
	"mass_mention_action" text DEFAULT 'MUTE' NOT NULL,
	"link_threshold_action" text DEFAULT 'MUTE' NOT NULL,
	"staff_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"alert_channel_id" bigint
);
--> statement-breakpoint
CREATE TABLE "self_assignable_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"role_id" bigint NOT NULL,
	"label" text,
	"emoji" text,
	"group_name" text,
	"exclusive" boolean DEFAULT false NOT NULL,
	"active" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "self_role_selections" (
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"role_id" bigint NOT NULL,
	"selected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "self_role_selections_guild_id_user_id_role_id_pk" PRIMARY KEY("guild_id","user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "setup_state" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"step" "setup_step" DEFAULT 'START' NOT NULL,
	"selections" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "suspicious_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"code" text NOT NULL,
	"code_hash" text NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"action" text DEFAULT 'LOG' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "temp_voice_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"owner_id" bigint NOT NULL,
	"channel_id" bigint NOT NULL,
	"status" "temp_voice_status" DEFAULT 'ACTIVE' NOT NULL,
	"member_limit" integer,
	"user_limit" integer,
	"moved_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "temp_voice_settings" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"hub_channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"category_id" bigint,
	"default_name_template" text DEFAULT '{username}''s channel' NOT NULL,
	"max_channels" integer DEFAULT 50 NOT NULL,
	"auto_close_empty" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_captcha" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"answer_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"solved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_state" (
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"status" "verification_status" DEFAULT 'PENDING' NOT NULL,
	"verified_role_id" bigint,
	"verified_at" timestamp with time zone,
	"token" text,
	"token_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "verification_state_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "welcome_profiles" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"verification_enabled" boolean DEFAULT false NOT NULL,
	"verification_mode" text DEFAULT 'CAPTCHA' NOT NULL,
	"verification_role_id" bigint,
	"verification_channel_id" bigint,
	"verification_timeout_minutes" integer DEFAULT 10 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "welcome_settings" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"channel_id" bigint,
	"message" text DEFAULT 'Welcome, {user}!' NOT NULL,
	"show_member_count" boolean DEFAULT false NOT NULL,
	"direct_message_enabled" boolean DEFAULT false NOT NULL,
	"direct_message_message" text,
	"leave_channel_id" bigint
);
--> statement-breakpoint
ALTER TABLE "ai_decisions" ADD CONSTRAINT "ai_decisions_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_commands" ADD CONSTRAINT "analytics_commands_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_daily" ADD CONSTRAINT "analytics_daily_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_forms" ADD CONSTRAINT "application_forms_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_submissions" ADD CONSTRAINT "application_submissions_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_submissions" ADD CONSTRAINT "application_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_submissions" ADD CONSTRAINT "application_submissions_form_id_application_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."application_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_roles" ADD CONSTRAINT "auto_roles_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "honeypot_channels" ADD CONSTRAINT "honeypot_channels_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "honeypot_trips" ADD CONSTRAINT "honeypot_trips_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lockdown_state" ADD CONSTRAINT "lockdown_state_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_analytics" ADD CONSTRAINT "message_analytics_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raid_mode" ADD CONSTRAINT "raid_mode_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_notes" ADD CONSTRAINT "report_notes_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_notes" ADD CONSTRAINT "report_notes_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_queries" ADD CONSTRAINT "search_queries_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_settings" ADD CONSTRAINT "security_settings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_assignable_roles" ADD CONSTRAINT "self_assignable_roles_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_role_selections" ADD CONSTRAINT "self_role_selections_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_role_selections" ADD CONSTRAINT "self_role_selections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_state" ADD CONSTRAINT "setup_state_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspicious_invites" ADD CONSTRAINT "suspicious_invites_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temp_voice_channels" ADD CONSTRAINT "temp_voice_channels_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temp_voice_settings" ADD CONSTRAINT "temp_voice_settings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_captcha" ADD CONSTRAINT "verification_captcha_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_state" ADD CONSTRAINT "verification_state_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_state" ADD CONSTRAINT "verification_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "welcome_profiles" ADD CONSTRAINT "welcome_profiles_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "welcome_settings" ADD CONSTRAINT "welcome_settings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appeals_case_unique" ON "appeals" USING btree ("guild_id","case_id") WHERE "appeals"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "appeals_guild_status_idx" ON "appeals" USING btree ("guild_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "applications_open_unique" ON "application_submissions" USING btree ("guild_id","user_id","form_id") WHERE "application_submissions"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "applications_guild_status_idx" ON "application_submissions" USING btree ("guild_id","status");--> statement-breakpoint
CREATE INDEX "applications_user_idx" ON "application_submissions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "message_analytics_channel_idx" ON "message_analytics" USING btree ("guild_id","channel_id");--> statement-breakpoint
CREATE INDEX "report_notes_report_idx" ON "report_notes" USING btree ("report_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_open_unique" ON "reports" USING btree ("guild_id","reporter_id","target_user_id") WHERE "reports"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "reports_queue_idx" ON "reports" USING btree ("guild_id","status","priority");--> statement-breakpoint
CREATE INDEX "reports_target_idx" ON "reports" USING btree ("guild_id","target_user_id");--> statement-breakpoint
CREATE INDEX "search_documents_kind_idx" ON "search_documents" USING btree ("guild_id","kind");--> statement-breakpoint
CREATE INDEX "search_queries_recent_idx" ON "search_queries" USING btree ("guild_id","created_at");--> statement-breakpoint
CREATE INDEX "self_role_selections_user_idx" ON "self_role_selections" USING btree ("guild_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "temp_voice_active_channel_unique" ON "temp_voice_channels" USING btree ("guild_id","channel_id") WHERE "temp_voice_channels"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "temp_voice_owner_idx" ON "temp_voice_channels" USING btree ("guild_id","owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_captcha_user_unique" ON "verification_captcha" USING btree ("guild_id","user_id");--> statement-breakpoint
CREATE INDEX "verification_captcha_expiry_idx" ON "verification_captcha" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "verification_pending_idx" ON "verification_state" USING btree ("guild_id") WHERE "verification_state"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "verification_token_idx" ON "verification_state" USING btree ("token");