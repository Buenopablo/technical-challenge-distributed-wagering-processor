# Jungle Gaming Backend Challenge

Backend em desenvolvimento para o desafio Distributed Wagering Processor da
Jungle Gaming. Além da fundação NestJS/TypeORM e da abertura de carteiras, esta
etapa implementa `POST /wagering/transactions` para `BET`, `WIN` e `LOSS`, com
idempotência persistente e processamento transacional no PostgreSQL.

Este projeto ainda não conclui o desafio. As operações BET/WIN/LOSS/REFUND/
ROLLBACK não estão todas implementadas: `REFUND` e `ROLLBACK` continuam
pendentes. Também faltam os endpoints de consulta, processamento SQS, Inbox,
Outbox, workers, retries, DLQ, reconciliação e observabilidade.

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

A migration de snapshots de idempotência recusa a reversão enquanto houver
transações externas em estado terminal (`PROCESSED`, `REJECTED` ou `FAILED`),
pois removeria os saldos originais necessários para responder a replays. Nesse
caso, a migration não faz alterações. Uma reversão exige uma estratégia de
arquivamento dos snapshots verificada separadamente; não se deve contornar a
proteção apagando transações.

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
rota HTTP que o exponha. O endpoint de transações descrito a seguir já está
disponível.

## Submeter uma transação de aposta

```http
POST /wagering/transactions
Idempotency-Key: provider-a:transaction-123
Content-Type: application/json
```

Body conforme o contrato oficial:

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

`Idempotency-Key` é obrigatório e aceita até 255 caracteres. A API exige os
campos do exemplo; os identificadores de jogador e carteira devem ser UUIDs.
Valores monetários são strings decimais com duas casas e moeda ISO suportada
por `Money`. `OPENING` é interno e não pode ser submetido.

Tipos implementados:

- `BET`: debita o valor; saldo insuficiente é persistido como `REJECTED`, com
  código `INSUFFICIENT_FUNDS`, sem alterar saldo ou criar ledger.
- `WIN`: credita o valor.
- `LOSS`: registra a transação sem alterar saldo ou criar ledger.

O README oficial não define se valores zero devem ser aceitos para essas
operações. A implementação permite `0.00`: a transação é registrada como
processada, sem alteração de saldo/versão e sem lançamento no ledger.

Resposta processada (`200`):

```json
{
  "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
  "status": "PROCESSED",
  "balance": { "amount": "975.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

Uma repetição idêntica retorna `idempotentReplay: true` e o saldo persistido
no resultado original, mesmo que a carteira tenha mudado depois. Operações
processadas retornam `200`; uma rejeição original e seu replay retornam `422`
com o mesmo resultado e código de falha. O hash SHA-256 considera os campos de
negócio em JSON com chaves ordenadas; o header e metadados de transporte não
entram no hash.

Comportamentos HTTP implementados:

| HTTP | Situação |
| --- | --- |
| `200` | Processamento bem-sucedido ou replay de operação processada. |
| `400` | Header ausente, payload inválido, moeda/valor inválido, campos obrigatórios de referência ausentes ou tentativa de enviar `OPENING`. |
| `404` | Carteira inexistente. |
| `409` | Mesma `Idempotency-Key` com conteúdo de negócio diferente. |
| `422` | Rejeição de negócio. O corpo inclui `transactionId`, `status`, `balance`, `idempotentReplay` e `failureCode`. |
| `501` | Payload válido de `REFUND` ou `ROLLBACK`, reconhecido pelo desafio, mas ainda não implementado nesta etapa. Essas operações exigem `referenceExternalTransactionId`; payload malformado retorna `400`. |
| `500` | Falha inesperada de infraestrutura; a transação SQL é revertida. |

O README oficial deixa o mapeamento HTTP a cargo do candidato. Para `409`,
`400`, `404` e `501`, a resposta usa o formato padrão de exceção do NestJS.
Falhas de negócio são persistidas e podem ser repetidas com replay do mesmo
resultado; falhas inesperadas não deixam uma transação parcial persistida.

## Limitações e próximos passos

- Estão implementados `OPENING`, `BET`, `WIN` e `LOSS`; `REFUND` e `ROLLBACK`
  ainda não têm fluxo financeiro.
- Ainda não há endpoints para criar ou consultar carteiras, transações,
  ledger ou reconciliação.
- A idempotência persistente e o bloqueio por carteira são implementados para
  o endpoint desta etapa; o processamento por SQS, Inbox/Outbox, retries, DLQ
  e referências pendentes ainda não.
- Ainda não há autenticação, health checks, métricas ou logs estruturados.

Os próximos passos devem seguir o escopo oficial do desafio e acrescentar
essas capacidades com testes de integração, sem tratar esta fundação como uma
solução concluída.

Os testes de integração de concorrência incluem três instâncias NestJS
independentes, cada uma com seu próprio servidor HTTP e pool PostgreSQL,
compartilhando apenas o banco temporário de teste. Isso exercita o lock no
banco entre instâncias, sem depender de coordenação em memória.
