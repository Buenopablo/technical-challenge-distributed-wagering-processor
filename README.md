# Jungle Gaming Backend Challenge

Backend em desenvolvimento para o desafio Distributed Wagering Processor da
Jungle Gaming. Além da fundação NestJS/TypeORM e da abertura de carteiras, o
projeto implementa `POST /wagering/transactions` para `BET`, `WIN`, `LOSS`,
`REFUND` e `ROLLBACK`, Inbox/Outbox persistentes, um consumidor da fila
financeira de entrada e um publisher independente dos eventos de integração
de saída.

Este projeto ainda não conclui o desafio. Referências ausentes são persistidas
como `PENDING_REFERENCE` e reprocessadas por um worker agendado. Também faltam
os endpoints de consulta, processamento operacional da DLQ, reconciliação e
observabilidade.
As requisições financeiras SQS usam o mesmo caso de uso HTTP, com Inbox,
efeitos financeiros, ledger e Outbox na mesma transação PostgreSQL.

## Pré-requisitos

- Bun 1.x (o `package.json` requer Bun `>=1.2.0`).
- Docker Compose.
- PostgreSQL 16 via Compose para desenvolvimento local.
- LocalStack com SQS para o ambiente local de mensageria.

## Configuração local

O Compose deste desafio utiliza container, rede e volume próprios, com o
PostgreSQL publicado somente em `127.0.0.1:55432`. Não é necessário parar ou
alterar containers de outros projetos.

```sh
docker compose up -d postgres localstack
bun install
```

As configurações padrão estão em `.env.example` e também são os defaults da
aplicação. Para personalizá-las localmente, copie esse arquivo para `.env` e
ajuste os valores. A senha padrão é apenas para desenvolvimento local.
O LocalStack deste projeto usa container exclusivo e expõe SQS somente em
`127.0.0.1:14566`; os nomes das filas vêm de
`SQS_WAGER_TRANSACTIONS_QUEUE` e `SQS_WAGER_TRANSACTIONS_DLQ`, com defaults
`wager-transactions.fifo` e `wager-transactions-dlq.fifo`. O script de
provisionamento e o healthcheck usam essas mesmas variáveis. A fila principal
tem redrive para a DLQ após cinco recebimentos sem confirmação. A fila de
eventos de saída tem uma DLQ exclusiva própria, também após cinco recebimentos
sem confirmação. O Compose não remove nem modifica outros containers ou bancos.

A fila de eventos de saída é independente: `SQS_WAGER_INTEGRATION_EVENTS_QUEUE`
tem default `wager-integration-events.fifo` e publica os eventos da Outbox.
Ela não possui consumidor downstream ativo nesta etapa. Usa
`SQS_WAGER_INTEGRATION_EVENTS_DLQ` (default
`wager-integration-events-dlq.fifo`), separada da DLQ da fila de entrada.
O publisher usa `SQS_ENDPOINT` quando configurado, `AWS_REGION` e essa variável
de fila. Para LocalStack, o SDK recebe credenciais fictícias locais; sem
endpoint customizado, usa a cadeia padrão de credenciais AWS. Não inclua
credenciais reais no repositório ou em `.env.example`.

O schema de `inbox_messages` e `outbox_messages` é preparado por migration.
O fluxo HTTP financeiro grava eventos em `outbox_messages` na mesma transação
SQL. O consumidor da fila de entrada registra o `MessageId` atribuído pelo
SQS e o hash do envelope validado na Inbox, e chama o mesmo caso de uso
financeiro do endpoint HTTP usando o mesmo `EntityManager`. Assim, a Inbox,
a carteira, a transação financeira, o ledger e os novos eventos Outbox
confirmam ou revertem juntos. A chave de idempotência financeira e seu hash
de payload continuam independentes da identidade da Inbox.

## Contratos de mensageria

O README oficial define a fila financeira FIFO `wager-transactions.fifo` e o
envelope `WagerTransactionRequested`, além de exigir processamento seguro sob
duplicatas e falhas. A mensagem de entrada contém `messageId`, `type`,
`occurredAt` e `data`, com `providerId`, `externalTransactionId`,
`idempotencyKey`, `playerId`, `walletId`, `roundId`, `gameId`, `kind` e
`money`. `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` são aceitos; `OPENING` é
interno. Reversões exigem `referenceExternalTransactionId`. Valores monetários
são strings decimais validadas por `Money`; `playerId` e `walletId` são UUIDs.
A Inbox usa o `MessageId` do transporte SQS junto ao `consumerName`, enquanto
a idempotência financeira usa a `idempotencyKey` e o hash do payload de negócio.

Os eventos de saída usam envelope versionado (`eventVersion: 1`) com `eventId`
estável persistido na Outbox junto ao evento,
`eventType`, `occurredAt` em ISO-8601 UTC (`Z`, precisão de até
milissegundos), `aggregateId` UUID da carteira,
`payload` e `causationId` / `correlationId` opcionais. Os payloads definidos
são:

- `WagerTransactionProcessed`: `transactionId`, `providerId`,
  `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`,
  `kind`, `money` e `resultBalance`.
- `WagerTransactionRejected`: mesmos campos, mais `failureCode`.
- `WagerTransactionPendingReference`: mesmos identificadores e valores da
  transação, mais `referenceExternalTransactionId`, quando a referência ainda
  não existe.
- `WalletBalanceChanged`: `transactionId`, `walletId`, `playerId`,
  `previousBalance` e `balance`.

Valores monetários no payload permanecem strings decimais. A mensagem de
entrada e os quatro tipos de evento de saída possuem validadores runtime e
testes unitários de serialização; os eventos também verificam UUIDs,
timestamp UTC válido, consistência de moeda e relação entre agregado e wallet.
Em `WagerTransactionRejected`, a moeda de `money` pode diferir da moeda de
`resultBalance` quando a rejeição ocorre por incompatibilidade de moeda; os
eventos de sucesso e de alteração de saldo exigem coerência de moeda.
O consumidor de entrada e o publisher de saída são processos independentes.
O consumidor processa a operação financeira e confirma no SQS somente após o
commit. A Outbox publica eventos de integração, mas não há consumidor
downstream para essa fila nesta etapa; portanto, nenhum processo lê ou exclui
essas mensagens.

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

A migration `CreateInboxAndOutbox` cria as tabelas de Inbox e Outbox. Sua
reversão bloqueia as tabelas e verifica primeiro se qualquer uma contém
linhas; se houver dados, aborta com erro antes de remover tabelas ou registros.
`processed_at` é obrigatório porque a linha Inbox e o processamento financeiro
confirmam na mesma transação SQL do consumidor. A Outbox recebe eventos do processamento HTTP na mesma
transação financeira. A migration aditiva `AddOutboxFailureState` adiciona
`failed_at` e `last_error` para falhas terminais do publisher. Sua reversão
bloqueia a tabela e aborta antes de remover colunas se houver diagnóstico de
falha persistido. Claims expirados e eventos terminais são cobertos por testes
de integração em PostgreSQL temporário.
`AddWagerReferenceUniqueness` acrescenta unicidade por
`(provider_id, external_transaction_id)` para resolver referências sem
ambiguidade e uma constraint única parcial por
`(reference_transaction_id, kind)` para impedir reversões processadas
duplicadas do mesmo tipo. A migration valida dados preexistentes e falha sem
apagá-los se encontrar identidades ambíguas ou reversões duplicadas.
`AddPendingReferenceRetry` adiciona o contador e o próximo instante de
tentativa, agenda pendências preexistentes para reprocessamento e cria um
índice parcial para a busca das pendências vencidas. Sua reversão recusa
remover o estado de retry enquanto houver transações `PENDING_REFERENCE`.

Cada nova transação financeira processada grava `WagerTransactionProcessed`,
inclusive `LOSS`; uma rejeição de negócio persistida grava
`WagerTransactionRejected`. `WalletBalanceChanged` é gravado somente quando o
saldo muda. Replays idempotentes e conflitos não acrescentam eventos. Uma falha
ao criar ou gravar qualquer evento reverte a transação financeira inteira,
incluindo carteira, ledger e snapshot. Os `event_id` persistidos são estáveis
entre tentativas de publicação. A publicação pode gerar duplicatas se o SQS
aceitar uma mensagem e a confirmação PostgreSQL falhar; não há garantia
exactly-once.

## Publisher da Outbox

O processo de publicação é independente do servidor HTTP. Depois de iniciar
PostgreSQL e LocalStack, aplicar as migrations e configurar as variáveis acima,
execute em outro terminal:

```sh
bun run outbox:publish
```

No início, o processo valida a configuração e obtém a URL da fila de eventos
antes de reivindicar registros. A cada ciclo, reivindica no máximo dez eventos
e os envia com paralelismo limitado ao tamanho do lote. A seleção considera
eventos não publicados, não terminais, com `next_attempt_at` vencido e claim
ausente ou expirado. O claim é gravado em uma transação PostgreSQL curta com
`FOR UPDATE SKIP LOCKED`; a transação termina antes da chamada de rede. O lease
inicial é de 60 segundos e é renovado enquanto o envio SQS permanece ativo.
Claims abandonados podem ser recuperados após expirar; renovação, recuperação e
confirmação são atualizações condicionais pelo estado pendente e token atual.

O envelope é reconstruído das colunas da Outbox e do JSONB `payload`, validado
com `parseWagerIntegrationEvent()` e enviado como JSON. `aggregateId` é o
`MessageGroupId` e `eventId` é o `MessageDeduplicationId` estável. O publisher
seleciona somente o evento não resolvido mais antigo de cada carteira e envia
eventos de uma mesma carteira sequencialmente; eventos posteriores permanecem
bloqueados até o anterior ser publicado ou marcado terminal. O registro só
recebe `published_at` depois que o SQS confirma. Confirmação, reagendamento e
falha exigem estado pendente e token ainda atual, mas não rejeitam uma
atualização apenas porque o horário do lease venceu. A deduplicação FIFO tem
janela limitada e não elimina a possibilidade de duplicatas.

A renovação reduz a possibilidade de um segundo publisher recuperar um evento
enquanto a chamada original ainda está ativa, mas não cancela uma requisição SQS
já iniciada. Pausa do processo, falha prolongada da renovação ou timeout de
resultado ambíguo ainda podem permitir que uma requisição antiga seja aceita
depois da recuperação do evento e da publicação de um evento posterior da
carteira. Portanto, o publisher preserva a ordem na operação normal, mas não
garante ordenação absoluta nem exactly-once. Uma garantia mais forte exigirá
sequência/reordenação no consumidor, ainda não implementado.

Falhas de envio são reagendadas com backoff exponencial com jitter, máximo de
dez tentativas e atraso limitado a cinco minutos. A contagem é incrementada ao
reivindicar uma tentativa, para que claims abandonados por crash também contem.
Contrato ou erro AWS permanente específico da mensagem, ou limite de tentativas,
marca o evento com `failed_at` e `last_error`; isso não é a DLQ do SQS. Erros
globais conhecidos de fila, parâmetros incompatíveis ou credenciais liberam o
claim sem consumir tentativa e interrompem o processo. Erros transitórios
conhecidos e códigos desconhecidos seguem a política explícita de retry limitado;
códigos desconhecidos não são tratados como erro global nem como falha
permanente de mensagem. Eventos terminais exigem diagnóstico e intervenção
operacional.
SIGINT/SIGTERM impedem novos ciclos e aguardam o lote em curso; claims ainda não
concluídos permanecem recuperáveis por expiração.

Com PostgreSQL, LocalStack, fila provisionada e migrations aplicadas, inicie o
consumidor financeiro independente com `bun run inbox:consume`. Ele valida a
mensagem `WagerTransactionRequested`, registra na Inbox a identidade
`(consumerName, SQS MessageId)` e o hash SHA-256 canônico, então chama
`ProcessWagerTransactionUseCase.executeInTransaction()` com o mesmo
`EntityManager`. A Inbox, os efeitos financeiros, o ledger e a Outbox ficam
na mesma transação PostgreSQL. O `DeleteMessage` ocorre somente depois do
commit confirmado. Se a confirmação SQS falhar, a redelivery encontra a Inbox
já processada e não repete os efeitos; a idempotência financeira por
`idempotencyKey` protege também mensagens SQS distintas para a mesma operação.
Essas garantias oferecem processamento idempotente com entrega
at-least-once, não exactly-once.

Rejeições de negócio persistidas, como saldo insuficiente, são terminais e
confirmadas após o commit. Conflito da chave financeira com payload diferente
é tratado como terminal, com Inbox confirmada para evitar retries inúteis.
Falhas transitórias reconhecidas do PostgreSQL recebem atraso exponencial
curto por `ChangeMessageVisibility`; erros desconhecidos, falhas permanentes e
mensagens inválidas não são confirmados e seguem a política de redrive da fila
de entrada (cinco recebimentos até a DLQ). Erro permanente referente a carteira
inexistente também é deixado para redrive/DLQ. O README oficial não classifica
explicitamente uma carteira ausente; por segurança, o consumidor não confirma
nem grava Inbox/resultado financeiro, preservando a mensagem na DLQ para
inspeção e eventual reprocessamento em vez de descartar uma operação que possa
depender da ordem de criação da carteira. A DLQ requer investigação e
reprocessamento operacional, não implementados.

O consumidor processa mensagens do mesmo `MessageGroupId` sequencialmente
dentro do lote. Se uma mensagem não for confirmada (incluindo falha de
processamento ou de `DeleteMessage`), as seguintes desse grupo não avançam
naquele lote; grupos distintos continuam em paralelo. O envelope rejeita
campos desconhecidos em todos os níveis, para que conteúdo extra não seja
ignorado durante o cálculo do hash de integridade.

Assim que um lote é aceito, o consumidor inicia um heartbeat para cada
mensagem com receipt handle, inclusive as que aguardam sua vez atrás de uma
mensagem anterior do mesmo grupo FIFO. A visibilidade é renovada
periodicamente para o timeout configurado, em intervalos de metade desse
timeout, ao longo da espera local e do processamento. As operações de mudança
de visibilidade e ACK são serializadas por mensagem para evitar uma corrida
entre `ChangeMessageVisibility` e `DeleteMessage`; o heartbeat é encerrado e
aguardado após ACK, falha, interrupção do lote ou cancelamento. Em falha
transitória, ele para antes de definir o backoff de redelivery. Erros de
renovação são registrados e não são tratados como extensão bem-sucedida; novas
tentativas ocorrem no próximo intervalo, exceto para erros globais de
configuração, que interrompem a renovação. Se o SQS não aceitar as renovações,
a visibilidade vigente pode expirar e permitir redelivery; Inbox e
idempotência financeira mantêm os efeitos seguros, mas nenhum consumidor pode
garantir evitar redelivery ou DLQ durante uma indisponibilidade prolongada do
SQS.

SIGINT/SIGTERM interrompem novos polls e aguardam as mensagens em andamento
antes de fechar DataSource e cliente SQS. Se o prazo de encerramento expirar,
o processo continua aguardando o trabalho ativo antes de fechar recursos; caso
o processo seja encerrado externamente, mensagens não confirmadas podem ser
redeliveradas com segurança.

O publisher Outbox continua independente. Ele publica na fila de eventos de
integração; nenhum consumidor downstream dessa fila está ativo ou definido,
portanto as mensagens de saída não são lidas nem excluídas por esta aplicação.
A DLQ configurada para a fila de saída também não é monitorada por um
consumidor nesta etapa.

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
bun run outbox:publish   # inicia apenas o publisher da Outbox
bun run inbox:consume    # inicia apenas o consumidor financeiro da fila SQS
bun run references:process # inicia apenas o worker de referências pendentes
```

Os testes de integração conectam-se ao PostgreSQL configurado, criam um banco
temporário com nome único, aplicam migrations e removem somente esse banco ao
final. O usuário configurado precisa poder criar e remover databases. O teste
do publisher requer o LocalStack do projeto e cria uma fila FIFO temporária
exclusiva. Os testes do consumidor financeiro também requerem o LocalStack, criam uma
fila FIFO e uma DLQ temporárias exclusivas e as removem ao final. Nenhum teste
purga filas compartilhadas; os testes não limpam nem usam como banco de teste
o banco de desenvolvimento. Execute os testes direcionados com:

```sh
bun test test/integration/outbox-publisher.test.ts
bun test test/integration/wager-transaction-consumer.test.ts
```

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
- `REFUND`: credita uma `BET` processada uma única vez.
- `ROLLBACK`: aplica o efeito inverso de uma `BET`, `WIN` ou `REFUND`
  processada, uma vez por tipo de reversão.

As reversões exigem referência resolvida por `(providerId,
externalTransactionId)` e validam tipo permitido, player, wallet, moeda,
rodada e igualdade integral do valor. Referência ausente é persistida como
`PENDING_REFERENCE`, sem efeito no saldo/ledger, com snapshot para replay e
evento `WagerTransactionPendingReference`; a API responde `202`. A repetição
da mesma chave e payload retorna o mesmo status e snapshot com
`idempotentReplay: true`. `bun run references:process` inicia o worker
independente que busca pendências elegíveis e tenta resolver a referência.
Pendências seguem uma política de até oito tentativas ou 24 horas desde a
criação, o que ocorrer primeiro. A primeira tentativa ocorre após 5 segundos;
referências ausentes são reagendadas com backoff exponencial iniciado em
5 segundos e limitado a 1 hora. Oito tentativas sem referência ou a expiração
do TTL finalizam a transação como `REJECTED`, com `REFERENCE_NOT_FOUND` e
`WagerTransactionRejected`. A finalização, carteira, ledger e Outbox são
gravados atomicamente; a expiração prevalece mesmo se a referência surgir após
o TTL. O worker deve ser iniciado depois de aplicar as migrations.

Falhas de reversão que deixariam o saldo negativo são rejeitadas como
`REVERSAL_WOULD_NEGATIVE_BALANCE`, distinto de `INSUFFICIENT_FUNDS`. Os códigos
de referência incluem `REFERENCE_KIND_NOT_ALLOWED`,
`REFERENCE_NOT_PROCESSED`, `REFERENCE_INCOMPATIBLE`,
`REFERENCE_AMOUNT_MISMATCH` e `REFERENCE_ALREADY_REVERSED`.

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
| `202` | Reversão persistida como `PENDING_REFERENCE`, aguardando referência. |
| `400` | Header ausente, payload inválido, moeda/valor inválido, campos obrigatórios de referência ausentes ou tentativa de enviar `OPENING`. |
| `404` | Carteira inexistente. |
| `409` | Mesma `Idempotency-Key` com conteúdo de negócio diferente ou `externalTransactionId` já usado pelo provider. |
| `422` | Rejeição de negócio. O corpo inclui `transactionId`, `status`, `balance`, `idempotentReplay` e `failureCode`. |
| `500` | Falha inesperada de infraestrutura; a transação SQL é revertida. |

O README oficial deixa o mapeamento HTTP a cargo do candidato. Para `409`,
`400` e `404`, a resposta usa o formato padrão de exceção do NestJS.
Falhas de negócio são persistidas e podem ser repetidas com replay do mesmo
resultado; falhas inesperadas não deixam uma transação parcial persistida.

## Limitações e próximos passos

- Ainda não há endpoints para criar ou consultar carteiras, transações,
  ledger ou reconciliação.
- A idempotência persistente, o bloqueio por carteira e o processamento
  financeiro da fila de entrada são implementados. Inbox, caso de uso
  financeiro, ledger e Outbox compartilham a transação. O publisher Outbox
  envia eventos para a fila FIFO de saída, mas ainda não há consumidor
  downstream; processamento operacional de DLQ e reprocessamento continuam
  pendentes.
- Ainda não há autenticação, health checks, métricas ou logs estruturados.

Os próximos passos devem seguir o escopo oficial do desafio e acrescentar
essas capacidades com testes de integração, sem tratar esta fundação como uma
solução concluída.

Os testes de integração de concorrência incluem três instâncias NestJS
independentes, cada uma com seu próprio servidor HTTP e pool PostgreSQL,
compartilhando apenas o banco temporário de teste. Isso exercita o lock no
banco entre instâncias, sem depender de coordenação em memória.
