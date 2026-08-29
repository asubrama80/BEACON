/**
 * Safe interactive bootstrap for creating a local BEACON user — including, optionally, the
 * single local emergency break-glass administrator account. Intended to be run by an operator
 * directly in their own terminal against beacon_dev (or any environment they control).
 *
 * Usage: npm run bootstrap-user --workspace backend
 *
 * The password is entered interactively (masked when run in a real terminal) and is never
 * accepted as a command-line argument or environment variable, so it never ends up in shell
 * history, process listings, or committed files.
 */
import { createInterface } from "node:readline/promises";
import { eq } from "drizzle-orm";
import { getDb, closeDb, users, roles, userRoles } from "@beacon/database";
import { hashPassword } from "../src/modules/auth/password.js";
import { validatePasswordPolicy } from "../src/modules/auth/passwordPolicy.js";
import { loadAuthConfig } from "../src/modules/auth/config.js";

// Key codes are compared numerically (rather than as raw control-character string literals)
// to keep this file free of unprintable bytes: 3 = Ctrl-C, 4 = Ctrl-D/EOF, 8 = Backspace,
// 10 = LF, 13 = CR, 127 = DEL (the backspace key on most terminals).
function isEnterKey(code: number): boolean {
  return code === 10 || code === 13 || code === 4;
}
function isCtrlC(code: number): boolean {
  return code === 3;
}
function isBackspaceKey(code: number): boolean {
  return code === 8 || code === 127;
}

function promptVisible(rl: ReturnType<typeof createInterface>, query: string): Promise<string> {
  return rl.question(query);
}

function promptHidden(
  rl: ReturnType<typeof createInterface>,
  interactive: boolean,
  query: string,
): Promise<string> {
  if (!interactive) {
    // Non-interactive context (e.g. piped input): fall back to the same readline interface
    // used for the earlier visible prompts — creating a second interface on the same stdin
    // stream loses whatever input readline had already buffered internally.
    console.warn("(input not masked — not running in an interactive terminal)");
    return rl.question(query);
  }

  return new Promise((resolve, reject) => {
    process.stdout.write(query);
    const stdin = process.stdin;
    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");

    let input = "";
    const onData = (char: string): void => {
      const code = char.charCodeAt(0);

      if (isEnterKey(code)) {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(input);
        return;
      }
      if (isCtrlC(code)) {
        stdin.setRawMode(false);
        stdin.pause();
        process.stdout.write("\n");
        reject(new Error("Cancelled."));
        return;
      }
      if (isBackspaceKey(code)) {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      input += char;
      process.stdout.write("*");
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const config = loadAuthConfig();
  const db = getDb();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const interactive = process.stdin.isTTY === true;

  console.log("BEACON — local user bootstrap\n");

  const email = (await promptVisible(rl, "Email: ")).trim().toLowerCase();
  const displayName = (await promptVisible(rl, "Display name: ")).trim();
  const breakGlassAnswer = (await promptVisible(rl, "Is this the emergency break-glass admin account? (y/N): "))
    .trim()
    .toLowerCase();
  const isBreakGlass = breakGlassAnswer === "y" || breakGlassAnswer === "yes";

  // Assigning a role here — bypassing the ordinary /users API entirely — is the only way to
  // ever grant the very first ADMIN: role assignment through the API requires
  // `users.roles.assign`, which requires already being an admin. It's also the only way to
  // give the break-glass account a role at all, since the ordinary API refuses to touch it
  // once created (see claude/prompts/03-users-rbac.md).
  const availableRoles = await db.select({ id: roles.id, code: roles.code, name: roles.name }).from(roles);
  const roleAnswer = (
    await promptVisible(
      rl,
      `Assign a role now? (${availableRoles.map((r) => r.code).join(", ")}; leave blank to skip): `,
    )
  )
    .trim()
    .toUpperCase();
  const roleToAssign = roleAnswer ? availableRoles.find((r) => r.code === roleAnswer) : undefined;
  if (roleAnswer && !roleToAssign) {
    throw new Error(`Unknown role code: ${roleAnswer}`);
  }

  if (interactive) {
    // Free stdin from readline's control before switching to raw-mode password reading below.
    rl.close();
  }

  if (!email || !email.includes("@")) {
    throw new Error("A valid email is required.");
  }
  if (!displayName) {
    throw new Error("A display name is required.");
  }

  const password = await promptHidden(rl, interactive, "Password: ");
  const confirmPassword = await promptHidden(rl, interactive, "Confirm password: ");

  if (!interactive) {
    rl.close();
  }

  if (password !== confirmPassword) {
    throw new Error("Passwords do not match.");
  }

  const policyResult = validatePasswordPolicy(password, { email, displayName }, config);
  if (!policyResult.valid) {
    throw new Error(policyResult.reason);
  }

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    throw new Error(`A user with email ${email} already exists.`);
  }

  if (isBreakGlass) {
    const [existingBreakGlass] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.isBreakGlass, true))
      .limit(1);
    if (existingBreakGlass) {
      throw new Error(
        `A break-glass account already exists (${existingBreakGlass.email}). Only one is permitted.`,
      );
    }
  }

  const passwordHash = await hashPassword(password, config);

  const [created] = await db
    .insert(users)
    .values({ email, displayName, passwordHash, isBreakGlass })
    .returning({ id: users.id, email: users.email });
  if (!created) {
    throw new Error("User creation failed unexpectedly.");
  }

  if (roleToAssign) {
    await db.insert(userRoles).values({ userId: created.id, roleId: roleToAssign.id });
  }

  console.log(`\nUser created: ${created.email} (id: ${created.id})${roleToAssign ? ` — role: ${roleToAssign.code}` : ""}`);

  if (isBreakGlass) {
    console.log(
      "\nThis is the break-glass account. Per BEACON's emergency-initialization process, log in\n" +
        "immediately and enroll MFA (POST /auth/mfa/enroll then /auth/mfa/enroll/confirm) before\n" +
        "considering bootstrap complete — see claude/prompts/02-authentication.md for details.",
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error("\nBootstrap failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
