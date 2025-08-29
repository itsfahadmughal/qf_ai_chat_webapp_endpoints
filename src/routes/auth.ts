import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import bcrypt from "bcryptjs";
import { z } from "zod";
import crypto from "crypto";

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  hotelId: z.string()
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string()
});

const ForgotSchema = z.object({
  email: z.string().email()
});

const ResetSchema = z.object({
  token: z.string().min(10),
  newPassword: z.string().min(8)
});

const OtpVerifySchema = z.object({
  email: z.string().email(),
  code: z.string().min(4).max(8)
});

// Dev helper: in prod you should email the token/code; here we just log.
function devLeak<T extends object>(payload: T) {
  if (process.env.NODE_ENV !== "production") return payload;
  return {};
}

function generateResetToken() {
  return crypto.randomBytes(32).toString("hex"); // 64 chars
}

function generateOtpCode() {
  // 6-digit numeric
  return (Math.floor(100000 + Math.random() * 900000)).toString();
}

export async function authRoutes(app: FastifyInstance) {
  // --- Register ---
  app.post("/auth/register", async (req, reply) => {
    const { email, password, hotelId } = RegisterSchema.parse(req.body);

    const hotel = await prisma.hotel.findUnique({ where: { id: hotelId } });
    if (!hotel) return reply.code(400).send({ error: "Invalid hotelId" });
    if (!hotel.isActive) return reply.code(403).send({ error: "Hotel is deactivated" });

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return reply.code(409).send({ error: "Email already in use" });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({ data: { email, passwordHash, hotelId } });

    const token = await reply.jwtSign({ id: user.id, email: user.email });
    return { token };
  });

  // --- Login ---
  app.post("/auth/login", async (req, reply) => {
    const { email, password } = LoginSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return reply.code(401).send({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return reply.code(401).send({ error: "Invalid credentials" });

    const hotel = await prisma.hotel.findUnique({ where: { id: user.hotelId } });
    if (!hotel || !hotel.isActive) return reply.code(403).send({ error: "Hotel is deactivated" });

    const token = await reply.jwtSign({ id: user.id, email: user.email });
    return { token };
  });

  // --- Me ---
  app.get("/me", { preHandler: (app as any).authenticate }, async (req: any) => {
    return { id: req.user.id, email: req.user.email };
  });

  // --- Forgot Password ---
  app.post("/auth/forgot", async (req, reply) => {
    const { email } = ForgotSchema.parse(req.body ?? {});
    const user = await prisma.user.findUnique({ where: { email } });

    // Always respond 200 to avoid user enumeration
    if (!user) {
      return { ok: true, message: "If the email exists, a reset link has been sent." };
    }

    // invalidate old tokens (optional)
    await prisma.passwordResetToken.deleteMany({
      where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } }
    });

    // create reset token (1 hour)
    const token = generateResetToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await prisma.passwordResetToken.create({
      data: { userId: user.id, token, expiresAt }
    });

    // create OTP (10 minutes)
    const code = generateOtpCode();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000);
    await prisma.emailOtp.create({
      data: {
        userId: user.id,
        email,
        code,
        purpose: "password_reset",
        expiresAt: otpExpires
      }
    });

    // TODO: send email with token & code (Nodemailer / provider)
    console.log(`[DEV] Password reset token for ${email}: ${token}`);
    console.log(`[DEV] OTP code for ${email}: ${code}`);

    return {
      ok: true,
      message: "If the email exists, a reset link has been sent.",
      ...devLeak({ token, code, expiresAt, otpExpires })
    };
  });

  // --- Reset Password ---
  app.post("/auth/reset", async (req, reply) => {
    const { token, newPassword } = ResetSchema.parse(req.body ?? {});
    const rec = await prisma.passwordResetToken.findUnique({ where: { token } });

    if (!rec) return reply.code(400).send({ error: "Invalid or expired token" });
    if (rec.usedAt) return reply.code(400).send({ error: "Token already used" });
    if (rec.expiresAt <= new Date()) return reply.code(400).send({ error: "Token expired" });

    const user = await prisma.user.findUnique({ where: { id: rec.userId } });
    if (!user) return reply.code(400).send({ error: "Invalid token" });

    const passwordHash = await bcrypt.hash(newPassword, 10);

    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      prisma.passwordResetToken.update({ where: { id: rec.id }, data: { usedAt: new Date() } }),
      // (optional) invalidate outstanding OTPs for reset
      prisma.emailOtp.updateMany({
        where: {
          userId: user.id,
          purpose: "password_reset",
          consumedAt: null,
          expiresAt: { gt: new Date() }
        },
        data: { consumedAt: new Date() }
      })
    ]);

    return { ok: true };
  });

  // --- Verify OTP ---
  app.post("/auth/otp/verify", async (req, reply) => {
    const { email, code } = OtpVerifySchema.parse(req.body ?? {});
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return reply.code(400).send({ error: "Invalid code" });

    // Find latest unconsumed OTP for this email within expiry
    const otp = await prisma.emailOtp.findFirst({
      where: {
        userId: user.id,
        email,
        consumedAt: null,
        expiresAt: { gt: new Date() }
      },
      orderBy: { createdAt: "desc" }
    });

    if (!otp) return reply.code(400).send({ error: "Invalid or expired code" });
    if (otp.attempts >= 5) return reply.code(429).send({ error: "Too many attempts" });

    if (otp.code !== code) {
      await prisma.emailOtp.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } }
      });
      return reply.code(400).send({ error: "Invalid code" });
    }

    await prisma.emailOtp.update({
      where: { id: otp.id },
      data: { consumedAt: new Date() }
    });

    return { ok: true };
  });
}