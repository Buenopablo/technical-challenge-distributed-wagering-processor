import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { OpenWalletUseCase } from "./application/wallets/open-wallet.use-case";
import { createDatabaseOptions } from "./database/data-source";

@Module({
  imports: [TypeOrmModule.forRoot(createDatabaseOptions())],
  providers: [OpenWalletUseCase],
})
export class AppModule {}
