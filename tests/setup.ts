// Ensure Prisma client can initialize without a real database during unit tests.
process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test_db";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.JWT_SECRET ||= "test-secret";
