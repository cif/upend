import { pgTable, pgSchema, text, bigserial, timestamp, jsonb } from "drizzle-orm/pg-core";

// schema definitions for drizzle studio — not used for queries

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").unique().notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const things = pgTable("things", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  name: text("name").notNull(),
  data: jsonb("data").default({}),
  ownerId: text("owner_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const editingSessions = pgTable("editing_sessions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  prompt: text("prompt").notNull(),
  context: jsonb("context").default({}),
  status: text("status").notNull().default("pending"),
  result: text("result"),
  claudeSessionId: text("claude_session_id"),
  snapshotName: text("snapshot_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const sessionMessages = pgTable("session_messages", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  sessionId: bigserial("session_id", { mode: "number" }).references(() => editingSessions.id),
  role: text("role").notNull().default("user"),
  content: text("content").notNull(),
  status: text("status").notNull().default("pending"),
  result: text("result"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const oauthStates = pgTable("oauth_states", {
  state: text("state").primaryKey(),
  provider: text("provider").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
