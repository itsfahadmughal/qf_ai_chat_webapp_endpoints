import nodemailer from "nodemailer";

function bool(v: any) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return ["1","true","yes","y","on"].includes(v.toLowerCase());
  return false;
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: bool(process.env.SMTP_SECURE ?? false), // true for 465, false for others
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

export async function verifyMailer() {
  try {
    await transporter.verify();
    if (process.env.NODE_ENV !== "production") {
      console.log("[mailer] SMTP verified");
    }
  } catch (err) {
    console.error("[mailer] SMTP verify failed:", err);
  }
}

function buildResetLink(token: string) {
  const base = (process.env.FRONTEND_URL ?? "http://localhost:5173").replace(/\/$/, "");
  const path = (process.env.FRONTEND_RESET_PATH ?? "/reset-password").replace(/^\//, "");
  return `${base}/${path}?token=${encodeURIComponent(token)}`;
}

export async function sendPasswordResetEmail(opts: {
  to: string;
  token: string;
  code: string;             // OTP code
  expiresAt: Date;          // token expiry
  otpExpires: Date;         // OTP expiry
}) {
  const from = process.env.SMTP_FROM || "no-reply@qualityfriend.solutions";
  const resetUrl = buildResetLink(opts.token);
  const subject = "Reset your password";

  const text = [
    "You requested a password reset.",
    "",
    `Reset link (valid until ${opts.expiresAt.toISOString()}):`,
    resetUrl,
    "",
    `Your OTP code (valid until ${opts.otpExpires.toISOString()}): ${opts.code}`,
    "",
    "If you did not request this, you can ignore this email."
  ].join("\n");

  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:auto;padding:24px;border:1px solid #eee;border-radius:12px">
    <h2 style="margin:0 0 12px">Reset your password</h2>
    <p style="margin:0 0 16px;color:#444">You requested a password reset. Click the button below to pick a new password.</p>
    <p style="margin:16px 0">
      <a href="${resetUrl}" style="background:#0ea5e9;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;display:inline-block">Reset Password</a>
    </p>
    <p style="margin:16px 0;color:#444">Or open this link:</p>
    <p style="word-break:break-all;margin:8px 0 16px">${resetUrl}</p>
    <hr style="border:none;border-top:1px solid #eee;margin:16px 0" />
    <p style="margin:0 0 8px;color:#444">Your OTP code (for verification):</p>
    <p style="font-size:20px;letter-spacing:2px;margin:0 0 16px"><strong>${opts.code}</strong></p>
    <p style="margin:0;color:#777">Reset link valid until <strong>${opts.expiresAt.toISOString()}</strong>.<br/>OTP valid until <strong>${opts.otpExpires.toISOString()}</strong>.</p>
    <p style="margin:16px 0 0;color:#777">If you did not request this, you can ignore this email.</p>
  </div>`.trim();

  await transporter.sendMail({
    from,
    to: opts.to,
    subject,
    text,
    html
  });
}