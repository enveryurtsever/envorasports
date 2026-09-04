import { PrismaClient } from '@prisma/client';
import { generatePassword, hashPassword } from '../src/lib/auth/password';

/**
 * Creates or promotes an administrator.
 *
 *   npx tsx scripts/create-admin.ts <email> [password]
 *
 * With no password one is generated and printed exactly once — it is stored
 * only as a scrypt hash, so it cannot be recovered afterwards.
 */
const prisma = new PrismaClient();

async function main() {
  const email = (process.argv[2] ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    console.error('Usage: tsx scripts/create-admin.ts <email> [password]');
    process.exitCode = 1;
    return;
  }

  const password = process.argv[3] ?? generatePassword();
  const passwordHash = await hashPassword(password);

  const user = await prisma.user.upsert({
    where: { email },
    update: { role: 'ADMIN', passwordHash },
    create: { email, name: 'Administrator', role: 'ADMIN', passwordHash, locale: 'TR' },
    select: { id: true, email: true, role: true },
  });

  console.log('\nAdministrator ready');
  console.log(`  email    : ${user.email}`);
  console.log(`  role     : ${user.role}`);
  if (!process.argv[3]) {
    console.log(`  password : ${password}`);
    console.log('\n  Store it now — only the hash is kept.');
  }
  console.log('\n  Sign in at /login\n');
}

main()
  .catch((error) => {
    console.error('Failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
