import { AppDataSource } from "./data-source";

async function revertMigration(): Promise<void> {
  await AppDataSource.initialize();

  try {
    await AppDataSource.undoLastMigration();
    console.info("Reverted the last migration.");
  } finally {
    await AppDataSource.destroy();
  }
}

revertMigration().catch((error: unknown) => {
  console.error("Could not revert the last database migration.", error);
  process.exitCode = 1;
});
