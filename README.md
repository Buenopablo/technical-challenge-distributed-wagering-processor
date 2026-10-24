# Jungle Gaming Backend Challenge

## Requisitos locais

- Bun 1.x
- Docker Compose

## PostgreSQL local

O Compose deste projeto usa o container `jungle-wagering-foundation-postgres`,
a rede `jungle-wagering-foundation-network`, o volume
`jungle-wagering-foundation-postgres-data` e a porta `127.0.0.1:55432`.
Esses nomes são exclusivos deste desafio; não pare nem remova containers de
outros projetos.

```sh
docker compose up -d postgres
bun install
bun run db:migrate
bun test
```

A suíte de integração cria e remove um banco PostgreSQL temporário com nome
único. O usuário do banco precisa ter permissão para criar e remover bancos.
Os testes não apagam linhas do banco de desenvolvimento.

Para reverter a última migration aplicada:

```sh
bun run db:revert
```

As configurações padrão são somente para desenvolvimento local e podem ser
sobrescritas pelas variáveis de ambiente documentadas em `.env.example`.

## Estado desta etapa

Esta etapa contém NestJS, TypeORM, `Money`, domínio de wallet, abertura com
saldo inicial, transação interna `OPENING` e o lançamento imutável correspondente
no ledger. Não implementa BET/WIN/LOSS/REFUND/ROLLBACK, idempotência de apostas,
SQS, Inbox ou Outbox. Consulte `ARCHITECTURE.md` para as decisões atuais.