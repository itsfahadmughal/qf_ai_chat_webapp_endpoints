import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import bcrypt from "bcryptjs";
import { z, ZodError } from "zod";
import crypto from "crypto";
import { sendPasswordResetEmail } from "../lib/mailer.js";

const prismaAny = prisma as any;

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  hotelId: z.string(),
  userType: z.enum(["author", "reader"]).default("reader"),
  departmentId: z.string().optional()
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


  app.put("/auth/password", { preHandler: app.authenticate }, async (req: any, reply) => {
  try {
    const Body = z.object({
      currentPassword: z.string().min(1, "currentPassword is required"),
      newPassword: z.string().min(8, "newPassword must be at least 8 characters")
    }).parse(req.body ?? {});

    const me = await prismaAny.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, passwordHash: true }
    });
    if (!me) return reply.code(401).send({ error: "Unauthorized" });

    const ok = await bcrypt.compare(Body.currentPassword, me.passwordHash);
    if (!ok) return reply.code(400).send({ error: "Current password is incorrect" });

    if (Body.currentPassword === Body.newPassword) {
      return reply.code(400).send({ error: "New password must be different from current password" });
    }

    const newHash = await bcrypt.hash(Body.newPassword, 10);
    await prisma.user.update({
      where: { id: me.id },
      data: { passwordHash: newHash }
    });

      return { ok: true, message: "Password updated" };
    } catch (e: any) {
      if (e instanceof ZodError) {
        return reply.code(400).send({ error: "validation_error", details: e.errors });
      }
      req.log.error(e);
      return reply.code(500).send({ error: "Internal Server Error" });
    }
  });

  // --- Register ---
  app.post("/auth/register", async (req, reply) => {
    const { email, password, hotelId, userType, departmentId } = RegisterSchema.parse(req.body ?? {});
    const exists = await prismaAny.user.findUnique({ where: { email } });
    if (exists) return reply.code(409).send({ error: "Email already registered" });

    if (departmentId) {
      const department = await prismaAny.department.findFirst({
        where: { id: departmentId, hotelId }
      });
      if (!department) {
        return reply.code(400).send({ error: "invalid_department", details: "Department does not belong to provided hotel" });
      }
    }

    const hash = await bcrypt.hash(password, 10);
    const user = await prismaAny.user.create({
      data: {
        email,
        passwordHash: hash,
        hotelId,
        role: userType as any,
        departmentId: departmentId ?? null
      }
    });

    const token = app.jwt.sign({ id: user.id, role: user.role });
    return { token };
  });

  app.post("/auth/login", async (req, reply) => {
    const { email, password } = LoginSchema.parse(req.body ?? {});
    const user = await prismaAny.user.findUnique({ where: { email } });
    if (!user) return reply.code(401).send({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return reply.code(401).send({ error: "Invalid credentials" });

    const token = app.jwt.sign({ id: user.id, role: user.role });
    return { token };
  });

  // --- Me ---
  // --- Me (fetch from DB; select only existing fields on your User model) ---
  app.get("/me", { preHandler: app.authenticate }, async (req: any, reply) => {
    const me = await prismaAny.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        role: true,
        hotelId: true,
        departmentId: true,
        createdAt: true,
        hotel: { select: { id: true, name: true, isActive: true } },
        department: { select: { id: true, name: true, isActive: true } }
      }
    });

    if (!me) return reply.code(404).send({ error: "User not found" });
    return me;
  });

  // NEW: Set/assign hotel to current user
  app.put("/me/hotel", { preHandler: app.authenticate }, async (req: any, reply) => {
    const Body = z.object({ hotelId: z.string() }).parse(req.body ?? {});
    const hotel = await prisma.hotel.findUnique({ where: { id: Body.hotelId } });
    if (!hotel) return reply.code(404).send({ error: "Hotel not found" });
    if (hotel.isActive === false) return reply.code(403).send({ error: "Hotel is inactive" });

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: { hotelId: Body.hotelId },
      select: { id: true, email: true, hotelId: true }
    });
    return updated;
  });

  // --- Forgot Password ---
  app.post("/auth/forgot", async (req, reply) => {
    const { email } = ForgotSchema.parse(req.body ?? {});
    const user = await prismaAny.user.findUnique({ where: { email } });

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

    try {
      await sendPasswordResetEmail({
        to: email,
        token,
        code,
        expiresAt,
        otpExpires
      });
    } catch (err) {
      console.error("[forgot] failed to send email:", err);
      // Still return generic OK to avoid enumeration / UX leakage
    }

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

    const user = await prismaAny.user.findUnique({ where: { id: rec.userId } });
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
    const user = await prismaAny.user.findUnique({ where: { email } });
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
