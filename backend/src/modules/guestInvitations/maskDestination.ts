/** Shared by Module 17 (public landing page) and Module 18 (OTP request response) — a masked
 * destination is the only form of a Guest's contact info ever returned by any API response. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  const visible = local.slice(0, 1);
  return `${visible}${"*".repeat(Math.max(local.length - 1, 3))}@${domain}`;
}

export function maskPhone(phone: string): string {
  const last4 = phone.slice(-4);
  return `***-***-${last4}`;
}

export function maskDestination(email: string | null, mobilePhone: string | null): string {
  if (email) return maskEmail(email);
  if (mobilePhone) return maskPhone(mobilePhone);
  return "";
}
