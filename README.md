# Jungle Gaming Backend Challenge

Backend em desenvolvimento para o desafio Distributed Wagering Processor da
Jungle Gaming. A implementação atual estabelece a fundação NestJS/TypeORM e
implementa a abertura de carteiras com saldo inicial, incluindo a transação
interna `OPENING` e seu lançamento de crédito no ledger.

Este projeto ainda não conclui o desafio. As operações BET/WIN/LOSS/REFUND/
ROLLBACK, a API HTTP, idempotência de operações externas, concorrência do
processamento de apostas, SQS, Inbox, Outbox, workers e observabilidade ainda
não estão implementados.

## Pré-requisitos

- Bun 1.x (o `package.json` requer Bun `>=1.2.0`).
- Docker Compose.
- PostgreSQL 16 via Compose para desenvolvimento local.

## Configuração local

O Compose deste desafio utiliza container, rede e volume próprios, com o
PostgreSQL publicado somente em `127.0.0.1:55432`. Não é necessário parar ou
alterar containers de outros projetos.

```sh
docker compose up -d postgres
bun install
```

As configurações padrão estão em `.env.example` e também são os defaults da
aplicação. Para personalizá-las localmente, copie esse arquivo para `.env` e
ajuste os valores. A senha padrão é apenas para desenvolvimento local.

## Banco de dados e migrations

Aplicar as migrations pendentes:

```sh
bun run db:migrate
```

Reverter a última migration aplicada:

```sh
bun run db:revert
```

Cada execução de `db:revert` desfaz somente a última migration. O DataSource
compartilhado pela aplicação e pelos comandos de migration mantém
`synchronize` e execução automática de migrations desativados; o schema é
alterado explicitamente pelas migrations versionadas.

## Verificações e execução

Os scripts abaixo estão definidos em `package.json`:

```sh
bun test                 # suíte completa
bun run test:unit        # testes unitários
bun run test:integration # testes de integração PostgreSQL
bun run typecheck        # TypeScript estrito, sem emitir arquivos
bun run build            # build TypeScript de produção
bun run start            # inicia a aplicação
bun run start:dev        # inicia com Bun watch
```

Os testes de integração conectam-se ao PostgreSQL configurado, criam um banco
temporário com nome único, aplicam e revertem migrations e removem esse banco
ao final. O usuário configurado precisa poder criar e remover databases. Os
testes não limpam nem usam como banco de teste o banco de desenvolvimento.

## Fluxo implementado: abertura de carteira

`OpenWalletUseCase` recebe um `playerId` e um saldo inicial representado por
`{ amount, currency }`. O valor é validado pelo objeto `Money` antes de
qualquer gravação.

Em uma única transação PostgreSQL, o caso de uso:

1. Cria a carteira com versão inicial `1`.
2. Se o saldo for positivo, cria uma transação interna `OPENING`, marcada como
   `PROCESSED`.
3. Cria um lançamento `CREDIT` no ledger, registrando saldo anterior e
   posterior.
4. Confirma a transação somente se todas as gravações forem concluídas.

Saldo inicial zero cria somente a carteira. Uma falha ao gravar a operação ou
o ledger causa rollback das gravações da mesma transação. Carteiras duplicadas
para o mesmo jogador e moeda são impedidas pela constraint de unicidade do
banco.

`OpenWalletUseCase` está registrado como provider NestJS, mas ainda não há
controller ou rota HTTP que o exponha. A aplicação inicia em
`http://127.0.0.1:3000`; não existem endpoints de negócio implementados nesta
etapa.

## Limitações e próximos passos

- O domínio contém os tipos de transação e estados previstos, mas o fluxo
  financeiro implementado é somente `OPENING`.
- `Wallet` tem operações de domínio de crédito e débito, mas ainda não há
  persistência de alterações de saldo para apostas ou outros tipos.
- Ainda não há endpoints para criar ou consultar carteiras, transações,
  ledger ou reconciliação.
- Idempotência de transações externas, proteção contra concorrência de
  apostas, Inbox/Outbox, SQS, retries, DLQ e processamento de referências
  pendentes não estão implementados.
- Ainda não há autenticação, health checks, métricas ou logs estruturados.

Os próximos passos devem seguir o escopo oficial do desafio e acrescentar
essas capacidades com testes de integração, sem tratar esta fundação como uma
solução concluída.
