# Arquitetura atual

## Escopo e organização

O projeto é uma aplicação NestJS em TypeScript estrito, executada com Bun e
persistida em PostgreSQL por TypeORM. A arquitetura está sendo construída
incrementalmente. Os fluxos verticais implementados são a abertura de
carteiras e o processamento HTTP de `BET`, `WIN` e `LOSS`, incluindo ledger,
idempotência persistente e concorrência por carteira.

As responsabilidades estão organizadas em:

- `src/domain/`: regras e objetos de domínio sem dependência de NestJS ou
  TypeORM. Contém `Money`, `Wallet`, `WagerTransaction` e
  `WalletLedgerEntry`.
- `src/application/wallets/` e `src/application/wagering/`: casos de uso de
  abertura e processamento financeiro, que coordenam domínio e persistência.
- `src/http/`: controller de `POST /wagering/transactions`, responsável pela
  validação de entrada e pelo mapeamento de erros para HTTP.
- `src/database/entities/`: mapeamento das tabelas PostgreSQL para TypeORM.
- `src/database/migrations/`: criação versionada e reversível do schema.
- `src/database/data-source.ts`: opções compartilhadas pela aplicação e pelos
  comandos de migration.
- `test/unit/` e `test/integration/`: testes de domínio e validação contra
  PostgreSQL real.
- `src/app.module.ts` e `src/main.ts`: composição e inicialização do NestJS.

Os casos de uso estão registrados no módulo NestJS. Existe somente o endpoint
`POST /wagering/transactions` nesta etapa. Consultas, outros endpoints,
reversões, mensageria e demais partes do desafio permanecem planejadas.

## Modelos de domínio

### Money

`Money` recebe valores como strings decimais não negativas com exatamente duas
casas, por exemplo `{ "amount": "25.00", "currency": "BRL" }`. A factory
valida o formato, o intervalo e o código de moeda. Operações aritméticas
retornam novas instâncias e rejeitam moedas diferentes. Subtração e negação
podem produzir valores intermediários negativos; as factories de entrada e as
invariantes de carteira impedem que esses valores sejam aceitos como saldo
inicial ou saldo final.

Internamente o valor é representado por `bigint` em unidades mínimas: `25.00`
é `2500n`. Conversões entre string decimal e `bigint` são feitas por parsing
textual e divisão inteira; valores monetários não passam por `number`.
`toString()` e `toJSON()` serializam com escala fixa de duas casas. A instância
é congelada em runtime, além de expor estado privado e somente leitura.

No PostgreSQL, valores monetários usam `NUMERIC(20,2)`. O driver TypeORM/PG
mantém esse tipo como string; as entidades declaram os campos como `string` e
o domínio reidrata os valores com `Money`. A aplicação rejeita valores fora
do intervalo representável antes da persistência. Não há arredondamento
silencioso.

### Wallet

`Wallet.open()` cria uma carteira a partir de um identificador, jogador,
`Money` inicial e instante de criação; a versão começa em `1`. A moeda é
derivada do `Money` inicial. Crédito e débito validam o sinal e a moeda,
rejeitam saldo negativo e retornam os saldos anterior e posterior. A versão e
`updatedAt` só mudam quando o saldo efetivamente muda. `rehydrate()` reconstrói
o estado persistido.

O agregado de domínio não implementa locking nem persistência. O caso de uso
coordena essas operações, e a constraint de banco garante unicidade por
jogador/moeda e impede saldo negativo.

### WagerTransaction

O domínio e o schema representam os tipos `OPENING`, `BET`, `WIN`, `LOSS`,
`REFUND` e `ROLLBACK`, assim como os estados `PENDING`, `PENDING_REFERENCE`,
`PROCESSED`, `REJECTED` e `FAILED`. O caso de uso de aposta desta etapa
processa `BET`, `WIN` e `LOSS`; `OPENING` continua interno e `REFUND`/
`ROLLBACK` ainda não são processados.

`WagerTransaction.createOpening()` exige valor positivo, cria a transação
inicialmente como `PENDING`, sem identificadores de origem externa, e
`markProcessed()` a move para `PROCESSED` uma única vez. Para esse registro,
`OpenWalletUseCase` usa a chave `OPENING:<walletId>` e gera um SHA-256 de um
JSON com propriedades em ordem fixa. O hash e a chave identificam esse
registro interno. `createExternal()` cria transações externas em `PENDING`;
`reject()` grava um código de falha e torna a rejeição terminal.

Para o fluxo `BET`/`WIN`/`LOSS`, `ProcessWagerTransactionUseCase` calcula um
SHA-256 dos campos de negócio serializados com as chaves ordenadas
recursivamente. `Idempotency-Key` não entra no hash: ela é a chave persistente
que localiza a solicitação, enquanto o hash detecta reutilização com outro
payload.

O schema permite campos de origem nulos para `OPENING` e exige que estejam
presentes para os outros tipos. Regras completas de transição, falhas e
referências de `REFUND`/`ROLLBACK` ainda não foram implementadas.

### WalletLedgerEntry

O lançamento é criado por factory, não oferece métodos de mutação e valida
valor positivo, direção e igualdade aritmética entre saldo anterior, valor e
saldo posterior. Crédito e débito devem reconciliar com os saldos registrados.
Uma transação pode produzir no máximo um lançamento por carteira, conforme a
constraint única do banco.

Esse modelo não é um ledger de partidas dobradas; o README oficial apresenta
partidas dobradas como diferencial opcional. No estado atual há crédito de
`OPENING` e `WIN`, além de débito de `BET` processada.

## Fluxos transacionais

### Abertura de carteira

`OpenWalletUseCase.execute()` recebe `playerId` e saldo inicial textual. O
caso de uso valida o valor, cria o agregado Wallet e inicia uma transação
TypeORM. Dentro dela:

1. Insere a carteira.
2. Para saldo inicial positivo, cria e marca como processada a transação
   `OPENING`, então a insere.
3. Cria e insere o crédito de ledger com saldo anterior zero e saldo posterior
   igual ao saldo inicial.
4. Confirma a transação SQL somente após todas as gravações.

Se uma inserção falhar, a transação PostgreSQL desfaz as inserções feitas pelo
fluxo. Saldo inicial zero não cria `OPENING` nem lançamento. O resultado do
caso de uso contém o ID, jogador, saldo e versão inicial; esse caso de uso
ainda não é exposto por endpoint HTTP.

### Processamento de BET, WIN e LOSS

`WagerTransactionsController` valida o header e o body e chama
`ProcessWagerTransactionUseCase`. O caso de uso valida o `Money`, calcula o
hash e abre uma transação TypeORM/PostgreSQL.

1. Consulta uma transação existente pela chave. Se já existir, compara o hash
   e retorna o resultado final persistido ou sinaliza conflito.
2. Para uma nova operação, bloqueia somente a linha da carteira solicitada
   com `SELECT ... FOR UPDATE`.
3. Insere a transação em `PENDING`. A inserção usa
   `ON CONFLICT (idempotency_key) DO NOTHING`; isso evita abortar a transação
   PostgreSQL quando uma chamada concorrente ganha a disputa pela chave.
   Se não inserir, o caso de uso consulta a linha vencedora, compara o hash e
   retorna replay ou conflito sem aplicar efeitos financeiros.
4. Verifica jogador/moeda e aplica BET (débito), WIN (crédito) ou LOSS (sem
   alteração). Saldo insuficiente, jogador incompatível ou moeda incompatível
   resultam em rejeição de negócio persistida, com código estável.
5. Para mudança efetiva de saldo, atualiza a carteira e insere o lançamento
   correspondente. LOSS, valor zero e rejeições não criam lançamento nem
   alteram versão/saldo.
6. Atualiza estado final e snapshot do resultado original e confirma a mesma
   transação SQL.

O snapshot guarda saldo e moeda da resposta original (`result_balance` e
`result_currency`). Replay lê esse snapshot na linha de `wager_transactions`;
não consulta o saldo corrente da carteira para reconstruir a resposta. Isso
também preserva corretamente a moeda da carteira em uma rejeição por
incompatibilidade de moeda.

Uma falha inesperada em qualquer gravação propaga erro e faz rollback da
transação PostgreSQL, incluindo o registro idempotente, alteração de carteira
e ledger. Rejeição por regra de negócio é resultado terminal persistido; não
é tratada como falha de infraestrutura.

O README oficial não define se valores zero são válidos para BET/WIN/LOSS.
A implementação desta etapa permite zero como decisão explícita: registra a
transação como processada, mantém saldo e versão inalterados e não cria ledger.

## Persistência, migrations e garantias

`createDatabaseOptions()` configura entidades e migrations compartilhadas
pela aplicação, comandos de migration e testes. `synchronize: false` e
`migrationsRun: false`: a aplicação não altera o schema implicitamente nem
executa migrations ao iniciar.

As migrations atuais:

- Criam `wallets`, com unicidade em `(player_id, currency)`, saldo
  `NUMERIC(20,2)`, constraint de saldo não negativo, formato de moeda e
  versão positiva.
- Criam `wager_transactions` e `wallet_ledger_entries`, com constraints para
  tipos, estados, valores, moedas, hash, origem de `OPENING`, chaves únicas e
  referências entre carteira, transação e lançamento.
- Impõem no máximo um lançamento por `(transaction_id, wallet_id)` e
  consistência entre a carteira do lançamento e a carteira da transação.
- Validam que o saldo anterior e posterior correspondam à direção e ao valor
  do lançamento.
- Criam trigger PostgreSQL que rejeita `UPDATE` e `DELETE` em
  `wallet_ledger_entries`, tornando o ledger append-only no banco.
- A migration posterior adiciona unicidade global da `idempotency_key` e os
  campos `result_balance`/`result_currency`. Uma constraint exige snapshot
  para transações externas terminais. A migration é reversível e preserva as
  migrations anteriores.

As migrations têm operações `up` e `down`. `bun run db:revert` reverte uma
migration por execução; reverter todo o schema atual requer uma execução para
cada migration aplicada, na ordem inversa.

## Decisões e trade-offs

- **TypeORM:** é uma opção explicitamente aceita pelo desafio. Foi escolhido
  por familiaridade e por reduzir risco e tempo de implementação em comparação
  com a alternativa preferencial MikroORM. A configuração única e as
  migrations explícitas tornam visíveis as transações e mudanças de schema.
- **`bigint` e `NUMERIC(20,2)`:** `bigint` em unidades mínimas torna a
  aritmética exata no domínio; `NUMERIC` preserva precisão persistida sem
  recorrer a tipos binários de ponto flutuante. O intervalo está limitado ao
  que o schema suporta.
- **`OPENING` sem origem externa:** a abertura é interna, portanto os campos de
  provider, transação externa, rodada e jogo são nulos para esse tipo. Os
  demais tipos estão no schema, mas não são processados ainda.
- **Atomicidade e append-only no banco:** uma transação SQL coordena cada
  fluxo de abertura ou aposta; constraints e trigger protegem invariantes
  mesmo além das factories de domínio.
- **Idempotência persistente:** índice único global na `Idempotency-Key` e
  `ON CONFLICT DO NOTHING` protegem a admissão concorrente sem abortar a
  transação PostgreSQL. Chave repetida com hash igual reproduz o snapshot;
  com hash diferente retorna conflito. Não há dependência de cache em memória
  ou SQS.
- **Concorrência por carteira:** `SELECT FOR UPDATE` bloqueia somente a wallet
  afetada dentro da transação. Operações concorrentes na mesma carteira são
  serializadas pelo PostgreSQL; carteiras distintas não compartilham um lock
  global. A garantia é do banco e funciona entre conexões/processos.
- **Status HTTP:** `200` para processamento/replay processado; `422` para
  rejeição e seu replay; `409` para conflito de chave; `400` para entrada
  inválida; `404` para wallet
  inexistente; `501` para `REFUND`/`ROLLBACK` ainda não implementados; `500`
  para falhas inesperadas, após rollback.
- **Autenticação:** não está implementada. O desafio a considera opcional e
  sem pontos próprios. Se for adicionada, deve integrar um Identity Provider
  externo; o ponto de extensão será uma camada de autenticação/guard do NestJS,
  sem criar autenticação artesanal ou tabela local de senhas.

## Estado e evolução prevista

Implementado: fundação Bun/NestJS/TypeScript estrito, TypeORM, PostgreSQL,
migrations de wallet/OPENING/ledger e idempotência, `Money`, domínio de
Wallet/`WagerTransaction`/ledger, casos de uso transacionais de abertura e
processamento BET/WIN/LOSS, endpoint POST de transação, replay idempotente,
bloqueio por carteira e testes unitários e de integração com PostgreSQL real.

Ainda previsto: endpoint de abertura e endpoints de consulta; `REFUND` e
`ROLLBACK`; referências pendentes; SQS, Inbox, Outbox, retries e DLQ;
reconciliação, health checks, observabilidade e autenticação opcional. Os
testes atuais não pretendem validar três ou mais processos de aplicação,
mensageria nem recovery de workers. Cada componente deve ser implementado e
validado antes de ser descrito como capacidade disponível.
