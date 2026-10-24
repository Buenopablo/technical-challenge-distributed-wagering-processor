import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { OpenWalletUseCase } from "./application/wallets/open-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "./application/wagering/process-wager-transaction.use-case";
import { createDatabaseOptions } from "./database/data-source";
import { WagerTransactionsController } from "./http/wager-transactions.controller";

@Module({
  imports: [TypeOrmModule.forRoot(createDatabaseOptions())],
  controllers: [WagerTransactionsController],
  providers: [OpenWalletUseCase, ProcessWagerTransactionUseCase],
})
export class AppModule {}
