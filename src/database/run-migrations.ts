import { AppDataSource } from "./data-source";

async function runMigrations(): Promise<void> {
  await AppDataSource.initialize();

  try {
    const migrations = await AppDataSource.runMigrations();
    console.info(`Applied ${migrations.length} migration(s).`);
  } finally {
    await AppDataSource.destroy();
  }
}

runMigrations().catch((error: unknown) => {
  console.error("Could not apply database migrations.", error);
  process.exitCode = 1;
});
