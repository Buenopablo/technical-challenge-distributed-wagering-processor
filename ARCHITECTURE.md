# Arquitetura inicial

## Escopo

Esta etapa estabelece a fundação Bun + NestJS + TypeScript estrito, a conexão
com PostgreSQL por TypeORM, a migration inicial de wallets e o objeto de valor
`Money`. BET/WIN/LOSS, ledger completo, idempotência, SQS, Inbox e Outbox ficam
fora desta etapa.

## Money e precisão

`Money` recebe e serializa valores como strings decimais com exatamente duas
casas. Internamente usa `bigint` em unidades mínimas: por exemplo, `10.25 BRL`
é guardado como `1025n`. Não há conversão por `number`, nem arredondamento. O
limite é compatível com `NUMERIC(20,2)` no PostgreSQL; valores fora desse limite
são rejeitados antes da persistência. Valores negativos podem surgir em
operações intermediárias (`subtract`/`negate`), mas não são aceitos pela factory
de entrada do contrato.

O código da moeda é validado contra os códigos de moeda disponibilizados pelo
runtime via `Intl.supportedValuesOf("currency")`. Operações entre moedas
diferentes lançam `CurrencyMismatchError`.

## TypeORM e migrations

`createDatabaseOptions()` em `src/database/data-source.ts` é a fonte única de
configuração compartilhada pelo módulo NestJS, pelos comandos de migration e
pelos testes de integração. `synchronize` e `migrationsRun` ficam desativados:
alterações do schema são explícitas, versionadas e reversíveis.

A primeira migration cria `wallets` com:

- chave UUID;
- unicidade por `player_id` e `currency`;
- saldo `NUMERIC(20,2)` com constraint de não negatividade;
- formato básico de código de moeda e versão positiva.

Uma migration aditiva posterior cria `wager_transactions` e
`wallet_ledger_entries`. OPENING é a única transação implementada nesta etapa.
Como ela é interna, campos que identificariam uma operação externa
(`provider_id`, `external_transaction_id`, `round_id` e `game_id`) ficam nulos
somente nesse tipo. Uma constraint exige esses campos para os demais tipos,
que ainda não são processados. A chave interna é determinística por wallet
(`OPENING:<walletId>`), e o hash é SHA-256 de um JSON com ordem de propriedades
estável.

Ao abrir wallet com saldo positivo, o caso de uso grava wallet,
`WagerTransaction` em `PROCESSED` e crédito do ledger dentro da mesma
transação TypeORM/PostgreSQL. Se qualquer insert falhar, o banco desfaz todos.
Saldo inicial zero cria apenas a wallet, conforme o contrato do desafio.

`WalletLedgerEntry` valida aritmeticamente o lançamento antes de persistir.
No banco, FKs, unicidade por transação/wallet e um trigger append-only rejeitam
UPDATE e DELETE. O ledger de partidas dobradas não é implementado.

O domínio `Wallet` abre em `version = 1`; crédito/débito genéricos validam
moeda e não negatividade e só incrementam a versão quando o saldo muda. Esses
métodos de domínio ainda não representam operações BET/WIN/LOSS nem fazem parte
de um endpoint. No fluxo futuro, qualquer alteração persistida de saldo deverá
ser coordenada com um lançamento dentro da mesma transação.

O teste de integração usa PostgreSQL real em um banco temporário por execução,
aplica e reverte migrations, verifica constraints, valida o fluxo OPENING,
força uma falha no insert do ledger para provar rollback e confirma que o banco
rejeita update/delete do lançamento. O banco temporário é removido ao final;
o banco de desenvolvimento não é limpo pelos testes.

## Desenvolvimento local

O PostgreSQL é isolado com nomes exclusivos de container, rede e volume, além
da porta `127.0.0.1:55432`. As credenciais padrão do Compose são exclusivamente
para desenvolvimento local e devem ser substituídas em qualquer ambiente
compartilhado.