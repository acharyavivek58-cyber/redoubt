import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/core/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/redoubt',
  },
});