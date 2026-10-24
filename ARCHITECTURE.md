# Arquitetura atual

## Escopo e organização

O projeto é uma aplicação NestJS em TypeScript estrito, executada com Bun e
persistida em PostgreSQL por TypeORM. A arquitetura está sendo construída
incrementalmente. No momento, o caminho vertical implementado é a abertura de
uma carteira e, quando seu saldo inicial é positivo, o registro de uma
transação `OPENING` e do lançamento correspondente no ledger.

As responsabilidades estão organizadas em:

- `src/domain/`: regras e objetos de domínio sem dependência de NestJS ou
  TypeORM. Contém `Money`, `Wallet`, `WagerTransaction` e
  `WalletLedgerEntry`.
- `src/application/wallets/`: caso de uso `OpenWalletUseCase`, que coordena o
  domínio e a persistência.
- `src/database/entities/`: mapeamento das tabelas PostgreSQL para TypeORM.
- `src/database/migrations/`: criação versionada e reversível do schema.
- `src/database/data-source.ts`: opções compartilhadas pela aplicação e pelos
  comandos de migration.
- `test/unit/` e `test/integration/`: testes de domínio e validação contra
  PostgreSQL real.
- `src/app.module.ts` e `src/main.ts`: composição e inicialização do NestJS.

O caso de uso é registrado no módulo NestJS, mas ainda não há controllers ou
endpoints HTTP. Regras de apostas, mensageria e demais partes do desafio
permanecem planejadas, não implementadas.

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

O domínio não implementa ainda controle de concorrência de apostas nem
persistência dessas operações. A constraint de banco garante unicidade por
jogador e moeda e impede saldos negativos.

### WagerTransaction

O domínio e o schema representam os tipos `OPENING`, `BET`, `WIN`, `LOSS`,
`REFUND` e `ROLLBACK`, assim como os estados `PENDING`, `PENDING_REFERENCE`,
`PROCESSED`, `REJECTED` e `FAILED`. Isso não significa que todas essas
operações estejam implementadas: o caso de uso atual cria somente
`OPENING`.

`WagerTransaction.createOpening()` exige valor positivo, cria a transação
inicialmente como `PENDING`, sem identificadores de origem externa, e
`markProcessed()` a move para `PROCESSED` uma única vez. Para esse registro,
`OpenWalletUseCase` usa a chave `OPENING:<walletId>` e gera um SHA-256 de um
JSON com propriedades em ordem fixa. O hash e a chave identificam esse
registro interno; ainda não existe processamento idempotente de solicitações
externas.

O schema permite campos de origem nulos para `OPENING` e exige que estejam
presentes para os outros tipos. As regras completas de transição de estado,
falhas e referências dos demais tipos ainda não foram implementadas.

### WalletLedgerEntry

O lançamento é criado por factory, não oferece métodos de mutação e valida
valor positivo, direção e igualdade aritmética entre saldo anterior, valor e
saldo posterior. Crédito e débito devem reconciliar com os saldos registrados.
Uma transação pode produzir no máximo um lançamento por carteira, conforme a
constraint única do banco.

Esse modelo não é um ledger de partidas dobradas; o README oficial apresenta
partidas dobradas como diferencial opcional. No estado atual há somente o
crédito de `OPENING` para saldos iniciais positivos.

## Fluxo e atomicidade de OpenWallet

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
caso de uso contém o ID, jogador, saldo e versão inicial; ainda não existe
contrato HTTP público para esse resultado.

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
- **Atomicidade e append-only no banco:** a transação SQL coordena os registros
  de abertura; constraints e trigger protegem invariantes mesmo além das
  factories de domínio.
- **Autenticação:** não está implementada. O desafio a considera opcional e
  sem pontos próprios. Se for adicionada, deve integrar um Identity Provider
  externo; o ponto de extensão será uma camada de autenticação/guard do NestJS,
  sem criar autenticação artesanal ou tabela local de senhas.

## Estado e evolução prevista

Implementado: fundação Bun/NestJS/TypeScript estrito, TypeORM, PostgreSQL,
migrations de wallet/OPENING/ledger, `Money`, domínio de Wallet e
`WagerTransaction` para abertura, ledger append-only, caso de uso transacional
de abertura e testes unitários e de integração.

Ainda previsto: controllers e contratos HTTP oficiais; operações BET/WIN/
LOSS/REFUND/ROLLBACK; idempotência persistente de operações externas e replay
da resposta original; estratégia de concorrência por `walletId`; referências
pendentes; SQS, Inbox, Outbox, retries e DLQ; reconciliação, health checks,
observabilidade e autenticação opcional. Cada componente deve ser implementado
e validado antes de ser descrito como capacidade disponível.
