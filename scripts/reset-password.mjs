import { randomBytes, scryptSync } from "node:crypto";

const [, , identifier, newPassword] = process.argv;

function fail(message) {
  console.error(`\nError: ${message}\n`);
  console.error('Usage:');
  console.error('  node scripts/reset-password.mjs <email-or-user-id> "<new-password>"\n');
  console.error('Example:');
  console.error('  node scripts/reset-password.mjs mrnayak1432@gmail.com "myNewPass123"\n');
  process.exit(1);
}

if (!identifier) fail("email or user id is required.");
if (!newPassword) fail("new password is required.");
if (newPassword.length < 6) fail("password must be at least 6 characters.");

const password_salt = randomBytes(16).toString("hex");
const password_hash = scryptSync(newPassword, password_salt, 64).toString("hex");

const column = identifier.includes("@") ? "email" : "id";
const value = column === "email" ? identifier.trim().toLowerCase() : identifier.trim();

const sql = `UPDATE users
SET password_hash = '${password_hash}',
    password_salt = '${password_salt}'
WHERE ${column} = '${value}';`;

console.log("\n--- Copy the SQL below and run it in the Neon SQL Editor ---\n");
console.log(sql);
console.log("\n--- After running, log in with this password ---\n");
console.log(`  ${column}: ${value}`);
console.log(`  password: ${newPassword}\n`);
