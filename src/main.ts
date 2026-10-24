import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PORT ?? "3000");

  await app.listen(port, "127.0.0.1");
  console.info(`Application listening on http://127.0.0.1:${port}`);
}

bootstrap().catch((error: unknown) => {
  console.error("Could not start the application.", error);
  process.exitCode = 1;
});
