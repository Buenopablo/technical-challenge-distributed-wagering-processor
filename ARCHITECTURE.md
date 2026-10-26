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
- `src/application/outbox/`: reivindicação concorrente, reconstrução e
  publicação dos eventos persistidos na Outbox.
- `src/application/inbox/`: validação, Inbox transacional e polling das
  requisições financeiras recebidas por SQS.
- `src/messaging/sqs/`: configuração compartilhada de clientes SQS de
  publicação e consumo.
- `src/http/`: controller de `POST /wagering/transactions`, responsável pela
  validação de entrada e pelo mapeamento de erros para HTTP.
- `src/messaging/contracts/`: contratos versionados e validação da mensagem
  SQS de entrada e dos eventos de integração de saída.
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
processa `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`; `OPENING` continua
interno. Referências ausentes são persistidas como `PENDING_REFERENCE` e
resolvidas pelo processo independente `bun run references:process`.

`WagerTransaction.createOpening()` exige valor positivo, cria a transação
inicialmente como `PENDING`, sem identificadores de origem externa, e
`markProcessed()` a move para `PROCESSED` uma única vez. Para esse registro,
`OpenWalletUseCase` usa a chave `OPENING:<walletId>` e gera um SHA-256 de um
JSON com propriedades em ordem fixa. O hash e a chave identificam esse
registro interno. `createExternal()` cria transações externas em `PENDING`;
`reject()` grava um código de falha e torna a rejeição terminal.

Para todas as operações externas, `ProcessWagerTransactionUseCase` calcula um
SHA-256 dos campos de negócio serializados com as chaves ordenadas
recursivamente. `Idempotency-Key` não entra no hash: ela é a chave persistente
que localiza a solicitação, enquanto o hash detecta reutilização com outro
payload.

O schema permite campos de origem nulos para `OPENING` e exige que estejam
presentes para os outros tipos. A migration de unicidade garante resolução
inequívoca por `(provider_id, external_transaction_id)` e impede mais de uma
reversão processada do mesmo tipo para a mesma referência.

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
7. Constrói os eventos de integração, valida cada um com
   `parseWagerIntegrationEvent()` e insere os registros Outbox pelo mesmo
   `EntityManager`, antes de a transação confirmar.

Uma falha na construção, validação ou inserção de evento propaga erro e reverte
também a transação financeira, carteira, ledger e snapshot. Replays e conflitos
retornam antes da criação dos eventos; por isso não acrescentam registros à
Outbox.

Cada operação persistida como `PROCESSED` gera `WagerTransactionProcessed`,
inclusive `LOSS`. Uma rejeição de negócio persistida gera
`WagerTransactionRejected`. Uma reversão sem referência gera
`WagerTransactionPendingReference`, junto à persistência de
`PENDING_REFERENCE` e do snapshot do saldo inalterado. `WalletBalanceChanged`
é criado somente quando a operação altera o saldo, com os valores anterior e
posterior efetivos. Os IDs dos eventos são gerados uma vez para a operação e persistidos como
`event_id`; o publisher descrito abaixo reutiliza esse identificador em todas
as tentativas. O fluxo não garante entrega exactly-once.

### Worker de referências pendentes

`PendingReferenceWorker` consulta um lote limitado de transações cujo
`reference_next_attempt_at` venceu. Cada candidata é processada em sua própria
transação PostgreSQL. O caso de uso bloqueia primeiro a carteira e depois a
pendência, revalida status e vencimento sob lock, e bloqueia a transação de
referência ao encontrá-la. Workers concorrentes podem selecionar a mesma
candidata, mas o lock da carteira serializa seus efeitos; o segundo worker
revalida o estado e ignora a transação que já deixou de estar pendente.

As pendências têm no máximo oito tentativas ou 24 horas desde `created_at`,
o que ocorrer primeiro. A primeira tentativa é agendada para cinco segundos
após a criação. Quando a referência continua ausente, o contador aumenta e
o próximo instante segue backoff exponencial iniciado em cinco segundos,
limitado a uma hora. Uma referência ausente no oitavo lookup ou uma pendência
expirada é finalizada como `REJECTED` com `REFERENCE_NOT_FOUND`; o TTL expira
a operação mesmo que a referência apareça depois desse prazo.

Quando a referência existe, a validação de elegibilidade e compatibilidade e
a aplicação dos efeitos seguem as mesmas regras do processamento síncrono.
Atualizações de status/snapshot, carteira, ledger e eventos Outbox confirmam
na transação do worker. Falhas de persistência revertem todos esses efeitos;
uma candidata que permaneça pendente pode ser tentada de novo no próximo ciclo.
O Inbox da mensagem original não é alterado: ele já foi confirmado junto à
criação da pendência, e o worker não recebe uma nova mensagem SQS.

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
- `AddWagerReferenceUniqueness` torna inequívoca a busca por
  `(provider_id, external_transaction_id)` e impede duas reversões
  `PROCESSED` do mesmo tipo para a mesma transação referenciada. Antes de
  criar os índices únicos, valida duplicidades existentes e falha sem removê-las.

As migrations têm operações `up` e `down`. `bun run db:revert` reverte uma
migration por execução; reverter todo o schema atual requer uma execução para
cada migration aplicada, na ordem inversa. Há uma limitação intencional: o
`down()` da migration de snapshots verifica primeiro a existência de
transações externas terminais (`PROCESSED`, `REJECTED` ou `FAILED`) e falha
antes de qualquer operação destrutiva se encontrar alguma. Sem esses snapshots
não é possível reproduzir com segurança as respostas originais em replays.
Para reverter após operações financeiras, é necessária uma estratégia separada
e verificada de arquivamento; os snapshots não são descartados silenciosamente.
- A migration `CreateInboxAndOutbox` cria `inbox_messages` e
`outbox_messages`, incluindo unicidade por consumidor/mensagem e por
`event_id`, constraints de hash/versão/tentativas/payload/claim e índices
parciais para eventos pendentes e claims expirados.
- A migration aditiva `AddOutboxFailureState` registra `failed_at` e
  `last_error`. Seu `down()` bloqueia `outbox_messages` e recusa remover esses
  campos quando existem dados de falhas terminais.

### Schema preparado para Inbox e Outbox

`InboxMessageEntity` mapeia `consumer_name`, `message_id`, hash SHA-256,
`received_at` e `processed_at`. A chave primária composta por consumidor e
mensagem impede duplicação para o mesmo consumidor sem impedir consumidores
distintos de tratarem a mesma mensagem. `processed_at` é `NOT NULL` e recebe
default do banco; o consumidor financeiro insere a linha, executa o caso de
uso de aposta e atualiza `processed_at` dentro de uma transação PostgreSQL. O
`message_id` guarda o `MessageId` de transporte retornado pelo SQS, não o
`messageId` do envelope da aplicação. O hash SHA-256 é calculado sobre a
mensagem validada com as chaves dos objetos ordenadas recursivamente; reuso do
mesmo ID de transporte com outro hash é conflito de integridade e não é
confirmado no SQS.

`OutboxMessageEntity` mapeia o envelope do evento (`event_id`, tipo, versão,
agregado, instante de ocorrência, causation/correlation IDs) e seu payload
JSONB, além de criação, publicação, tentativas e próximo instante de tentativa.
Money em payload continua sendo representado como string JSON. O índice parcial
por `next_attempt_at, created_at` localiza eventos não publicados; outro índice
parcial cobre claims de eventos pendentes. `claimed_by` e `claim_expires_at`
são opcionais e a constraint exige que ambos estejam nulos ou preenchidos.
O publisher também usa `failed_at`/`last_error` para retirar eventos terminais
da seleção automática; a constraint garante que falha terminal sempre tenha
diagnóstico. A Outbox recebe eventos do processamento HTTP na mesma transação
financeira. A migration aditiva também cria um índice parcial por
`aggregate_id, created_at, event_id`, usado para ordenar os eventos pendentes
por agregado.

A reversão da migration bloqueia ambas as tabelas e verifica, antes de
qualquer operação destrutiva, se qualquer uma contém linhas. Com dados
presentes ela aborta com mensagem explícita e preserva tabelas e registros,
sem permitir uma inserção concorrente entre a verificação e o drop. A reversão
e reaplicação em banco temporário vazio são cobertas por testes de integração
PostgreSQL.

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
  demais tipos externos incluem as reversões com referências validadas.
- **Atomicidade e append-only no banco:** uma transação SQL coordena cada
  fluxo financeiro; constraints e trigger protegem invariantes
  mesmo além das factories de domínio.
- **Idempotência persistente:** índice único global na `Idempotency-Key` e
  `ON CONFLICT DO NOTHING` protegem a admissão concorrente sem abortar a
  transação PostgreSQL. Chave repetida com hash igual reproduz o snapshot;
  com hash diferente retorna conflito. Não há dependência de cache em memória
  ou SQS.
- **Concorrência por carteira:** `SELECT FOR UPDATE` bloqueia somente a wallet
  afetada dentro da transação. Operações concorrentes na mesma carteira são
  serializadas pelo PostgreSQL; carteiras distintas não compartilham um lock
  global. Reversões também bloqueiam a linha de referência e a unicidade
  parcial no banco protege contra duas reversões processadas do mesmo tipo.
  A garantia é do banco e funciona entre conexões/processos.
- **Status HTTP:** `200` para processamento/replay processado; `202` para uma
  reversão em `PENDING_REFERENCE`; `422` para
  rejeição e seu replay; `409` para conflito de chave; `400` para entrada
  inválida; `404` para wallet inexistente; `500` para falhas inesperadas,
  após rollback. O controller valida os campos obrigatórios,
  `referenceExternalTransactionId` e o formato de `Money`.
- **Autenticação:** não está implementada. O desafio a considera opcional e
  sem pontos próprios. Se for adicionada, deve integrar um Identity Provider
  externo; o ponto de extensão será uma camada de autenticação/guard do NestJS,
  sem criar autenticação artesanal ou tabela local de senhas.

## Estado e evolução prevista

Implementado: fundação Bun/NestJS/TypeScript estrito, TypeORM, PostgreSQL,
migrations de wallet/OPENING/ledger, idempotência e Inbox/Outbox, `Money`,
domínio de Wallet/`WagerTransaction`/ledger, casos de uso transacionais de
abertura e processamento BET/WIN/LOSS/REFUND/ROLLBACK, endpoint POST de transação, replay
idempotente, bloqueio por carteira, publisher Outbox e consumidor da fila
financeira de entrada com Inbox idempotente.
Os testes de concorrência também iniciam três instâncias NestJS independentes,
com servidores e pools próprios, para verificar a serialização no PostgreSQL
compartilhado. A migration de snapshots foi testada para recusar reversão
quando há transações externas terminais e manter seus dados e sua aplicação.

Ainda previsto: endpoint de abertura e endpoints de consulta; consumidor
downstream para eventos de integração da Outbox; processamento operacional
da DLQ, reconciliação, health checks, observabilidade e autenticação opcional.
O consumidor financeiro
compartilha a transação do caso de uso HTTP; o publisher Outbox e esse
consumidor são processos independentes. Os testes ainda não validam execução
em três ou mais processos do sistema operacional para o publisher.

## Preparação de SQS e contratos da etapa 4

O README oficial determina AWS SQS via LocalStack ou MiniStack e define a
mensagem financeira de entrada `WagerTransactionRequested`. Ele pressupõe
entrega `at-least-once`, redelivery, duplicatas e indisponibilidade temporária.
Inbox, operação financeira, ledger e Outbox são confirmados na mesma
transação. A Outbox alimenta uma fila de eventos de integração separada, sem
consumidor downstream definido nesta etapa.

O serviço LocalStack usa container próprio no Docker Compose e porta local
`14566`, sem substituir nem compartilhar os recursos PostgreSQL do projeto.
Os nomes vêm das variáveis `SQS_WAGER_TRANSACTIONS_QUEUE` e
`SQS_WAGER_TRANSACTIONS_DLQ`, compartilhadas pelo serviço, script de
provisionamento e healthcheck; os defaults são `wager-transactions.fifo` e
`wager-transactions-dlq.fifo`. O provisionamento cria as filas FIFO e configura redrive após cinco
recebimentos sem confirmação para a fila financeira de entrada. A fila de
eventos de saída tem uma DLQ exclusiva configurada por
`SQS_WAGER_INTEGRATION_EVENTS_DLQ`, mas não é consumida por este serviço.
FIFO e deduplicação do broker são otimizações, não substituem a idempotência
persistente.

A fila de saída `wager-integration-events.fifo` é provisionada por
`SQS_WAGER_INTEGRATION_EVENTS_QUEUE` e tem sua própria DLQ, sem compartilhar a
DLQ da fila de entrada. O publisher e o consumidor usam `SQS_ENDPOINT` para
LocalStack, `AWS_REGION` para a região, credenciais locais fictícias quando há
endpoint customizado e a cadeia padrão do SDK para AWS.

A mensagem de entrada segue o contrato `WagerTransactionRequested`: `messageId`,
`type`, `occurredAt` e `data`, com `providerId`, `externalTransactionId`,
`idempotencyKey`, `playerId`, `walletId`, `roundId`, `gameId`, `kind` e
`money`. A validação implementada aceita `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`,
exige `referenceExternalTransactionId` para reversões, valida identificadores,
timestamp UTC e Money sem conversão monetária para `number`, e rejeita
`OPENING`. O `MessageId` atribuído pelo transporte SQS junto ao `consumerName` é
a identidade da Inbox; `idempotencyKey` e o hash do payload de negócio
continuam protegendo a idempotência financeira. O `messageId` do envelope
permanece dado do contrato e não substitui o ID de transporte.

Os eventos de saída definidos para operações atuais compartilham um envelope
com `eventId` criado uma vez e persistido com o evento na Outbox,
`eventType`, `eventVersion: 1`, `occurredAt` ISO-8601 UTC com sufixo `Z` e
precisão de até milissegundos, `aggregateId` (UUID da wallet), `payload` e
`causationId`/`correlationId` opcionais.
`WagerTransactionProcessed` inclui operações `LOSS`, `WagerTransactionRejected`
carrega `failureCode`, `WagerTransactionPendingReference` informa reversões
aguardando referência e `WalletBalanceChanged` só é emitido se o saldo mudar.
O primeiro tipo contém identificadores do wager, `kind`, `money` e
`resultBalance`; o segundo contém os mesmos campos mais `failureCode`; o evento
de saldo contém `transactionId`, `walletId`, `playerId`, `previousBalance` e
`balance`. Money permanece serializado como string decimal. Os três eventos
têm validadores runtime que verificam campos, UUIDs, timestamp UTC válido,
moeda e coerência entre `aggregateId` e `walletId`; em rejeições, a moeda da
operação pode diferir da moeda do snapshot da carteira, por exemplo em uma
rejeição por incompatibilidade de moeda. Testes cobrem serialização e rejeição
para cada tipo. A mensagem de entrada também tem validação runtime e testes.
O caso de uso financeiro HTTP já gera e persiste os eventos na Outbox dentro
da transação correspondente.

### Publisher da Outbox

`bun run outbox:publish` inicia um processo separado, sem iniciar o servidor
HTTP. No bootstrap, valida as variáveis do SQS e obtém a URL da fila de saída
antes de conectar o DataSource e reivindicar qualquer registro. A aplicação
deve ter migrations aplicadas previamente; o publisher não executa migrations
automaticamente.

Cada ciclo reivindica no máximo dez eventos não publicados, não terminais e
com `next_attempt_at <= now()`, sem claim ou com claim expirado. A consulta
ordena por `next_attempt_at`, `created_at` e `event_id`, usa
`FOR UPDATE SKIP LOCKED` e grava token UUID único por lote mais lease de 60
segundos dentro de uma transação curta. A transação é confirmada antes de
qualquer chamada SQS. Até dez envios de carteiras distintas podem ocorrer em
paralelo; cada requisição tem timeout de 15 segundos. Somente o evento pendente
mais antigo de cada carteira fica elegível, de modo que eventos do mesmo
`MessageGroupId` sejam reivindicados e enviados sequencialmente no fluxo normal;
carteiras distintas avançam em paralelo. Isso não garante ordenação absoluta:
se o lease expirar enquanto uma chamada SQS antiga ainda estiver em andamento
ou tiver resultado ambíguo, ela ainda poderá ser aceita após a publicação de
um evento posterior.
O lease inicial é de 60 segundos e é renovado em intervalos durante uma chamada
SQS ativa. A renovação atualiza somente uma linha pendente cujo token ainda
corresponde ao publisher. Recuperação de lease expirado e renovação disputam o
lock da linha no PostgreSQL: se a renovação atualizar primeiro, a recuperação
observa o novo vencimento; se a recuperação substituir primeiro o token, a
renovação antiga não atualiza a linha. Claims abandonados ficam elegíveis
quando expiram.

O publisher reconstrói o envelope completo com `event_id`, tipo, versão,
`aggregate_id`, `occurred_at`, IDs opcionais não nulos e JSONB `payload`, e
valida-o por `parseWagerIntegrationEvent()`. Envia o JSON validado com
`aggregateId` como `MessageGroupId` e `eventId` como
`MessageDeduplicationId`. Somente depois da resposta SQS tenta preencher
`published_at`; a atualização confere event ID, estado não publicado e token
atual, limpando o claim. O vencimento do horário do lease, isoladamente, não
invalida a atualização; um token substituído impede que o publisher antigo
altere o estado. O mesmo critério de estado e token é usado para reagendamento
e falha terminal.

Na operação normal, eventos da carteira são enviados sequencialmente, e um
evento posterior não é reivindicado enquanto um evento anterior estiver
pendente. A renovação reduz a chance de um segundo publisher recuperar E1
durante seu envio ativo. Ela não pode cancelar uma chamada SQS antiga já
iniciada: se o processo parar de renovar ou ficar pausado além do lease, outro
publisher pode recuperar E1 e, após sua confirmação, publicar E2; a chamada
antiga ainda pode ter aceitação tardia. Timeout ambíguo ou falha da confirmação
PostgreSQL também podem causar republicação. A deduplicação FIFO reduz
duplicatas somente dentro da janela do SQS e não impede inversões decorrentes
de uma aceitação tardia. Portanto, o publisher mantém ordenação de seleção e
envio normal, mas não pode prometer ordenação absoluta nem exactly-once. Para
uma garantia mais forte, o consumidor futuro precisará validar sequência por
agregado ou reordenar eventos; esse controle ainda não está implementado.

Uma falha transitória ou timeout incrementa tentativas (contadas na aquisição
do claim), limpa o claim e agenda novo envio com backoff exponencial iniciado em
um segundo, jitter entre 0,5x e 1,5x e teto de cinco minutos. Após dez tentativas,
ou imediatamente diante de contrato inválido ou erro AWS permanente específico
da mensagem, grava `failed_at` e `last_error`, que retiram a linha da seleção
automática. Um claim expirado já na décima tentativa também é terminalizado no
próximo ciclo. Falhas terminais exigem intervenção operacional; não são
enviadas a uma DLQ. Erros globais conhecidos de fila, parâmetros incompatíveis
ou credenciais liberam os claims sem consumir tentativas e encerram o processo;
falha ao obter a fila ocorre antes de qualquer claim. Códigos AWS transitórios
conhecidos são reagendados; códigos desconhecidos seguem retry limitado e não
são assumidos como globais ou permanentes de mensagem. SIGINT/SIGTERM impedem
novos ciclos e aguardam o lote atual terminar, mantendo claims incompletos
recuperáveis por expiração.

O LocalStack recebe uma fila FIFO temporária exclusiva nos testes do publisher,
junto a um banco PostgreSQL temporário. O processo de teste remove somente
esses recursos que criou; não purga filas compartilhadas.

### Consumidor financeiro SQS e Inbox

`bun run inbox:consume` inicia um processo independente do servidor HTTP e do
publisher Outbox. No bootstrap, valida a configuração do SQS e do polling,
resolve a URL de `wager-transactions.fifo`, inicializa o DataSource e começa
long polling. Tamanho do lote e concorrência são limitados; por padrão ambos
são cinco, o long poll é de até 20 segundos e a visibilidade é de 30 segundos.
As opções podem ser ajustadas pelas variáveis `SQS_CONSUMER_*`.

O processor valida o envelope `WagerTransactionRequested`, calcula seu hash
canônico SHA-256 e inicia uma transação PostgreSQL. Insere
`(consumer_name, SQS MessageId, payload_hash)` na Inbox e então chama
`ProcessWagerTransactionUseCase.executeInTransaction()` com o mesmo
`EntityManager` fornecido à transação. O caso de uso financeiro é compartilhado
com HTTP: não há segundo handler que duplique a lógica. A carteira, wager,
ledger e eventos Outbox, quando aplicáveis, são persistidos nesse mesmo
manager. O commit inclui a Inbox e todos os efeitos, ou o rollback remove
todos. A chave composta da Inbox impede concorrência do mesmo ID de transporte
para o consumidor; a chave financeira e o hash de negócio continuam sendo
uma proteção separada para reenvios com outro `MessageId`.

O `messageId` dentro do envelope é validado como dado de contrato, mas não
substitui o `MessageId` atribuído pelo SQS como identidade da Inbox. Hashes
idênticos para uma linha Inbox existente são redelivery já processada; o
mesmo ID de transporte com conteúdo distinto é conflito de integridade e não
é confirmado. Payloads inválidos também não são confirmados.

O consumidor envia `DeleteMessage` apenas depois do commit PostgreSQL. Uma
falha no ACK pode gerar redelivery, reconhecida pela Inbox sem repetir efeitos.
Rejeições de negócio persistidas (por exemplo, saldo insuficiente) são
terminais e confirmadas depois do commit. Conflito de `idempotencyKey` com
payload de negócio diferente também é terminal e pode ser confirmado depois
do commit da Inbox; nenhuma transação financeira conflitante é criada.
Falhas transitórias reconhecidas do PostgreSQL recebem atraso exponencial
curto por `ChangeMessageVisibility`. Erros desconhecidos, erros permanentes,
carteira inexistente, conflito de integridade de Inbox e mensagem inválida não
são confirmados e seguem a redrive policy da fila de entrada, após cinco
recebimentos. A DLQ exige investigação e reprocessamento operacional, ainda
não implementados. O enunciado não especifica a classificação de carteira
inexistente. A decisão conservadora é não confirmar nem persistir Inbox ou
resultado financeiro: a mensagem segue para a DLQ para inspeção e possível
reprocessamento, evitando descartar uma operação que possa depender de ordem
de criação da carteira. Erros de configuração global do SQS interrompem o
processo em vez de serem tratados como falhas de negócio.

O polling respeita grupos FIFO: mensagens recebidas com o mesmo
`MessageGroupId` são processadas sequencialmente no lote, enquanto grupos
distintos podem avançar em paralelo. Se uma mensagem não for confirmada, o
restante do mesmo grupo é interrompido para esse lote; a redelivery é
responsável por retomar a sequência. O contrato rejeita campos desconhecidos
no envelope, em `data` e em `money`, impedindo que propriedades semânticas
adicionais sejam ignoradas no hash de integridade.

Assim que um lote é aceito, cada mensagem com receipt handle recebe um
heartbeat, inclusive as que aguardam na fila local do grupo FIFO. O consumidor
renova a visibilidade com `ChangeMessageVisibility` a cada metade do timeout
configurado, estendendo-a pelo mesmo timeout durante a espera e o
processamento. Mudanças de visibilidade e ACK são serializados por mensagem
para evitar corridas entre `ChangeMessageVisibility` e `DeleteMessage`. O
heartbeat é encerrado e aguardado após ACK, falha, interrupção do lote ou
cancelamento; em falha transitória, ele para antes de aplicar o backoff de
retry. Erros são registrados e não são considerados renovações bem-sucedidas.
Erros não globais permitem nova tentativa no próximo intervalo; erro global
de configuração interrompe o heartbeat e propaga a falha após a tarefa em
curso. Se o SQS rejeitar a renovação ou estiver indisponível, a visibilidade
vigente ainda pode expirar e causar redelivery ou redrive para DLQ. As
garantias persistentes de Inbox e idempotência protegem os efeitos financeiros,
mas não eliminam essa possibilidade durante indisponibilidade prolongada do
SQS.

SIGINT/SIGTERM interrompem novos polls, mas o heartbeat das mensagens em
andamento continua até elas terminarem; o encerramento aguarda o trabalho e a
parada de todas as renovações antes de fechar DataSource e cliente SQS. Após o
prazo de grace, o processo registra o atraso e continua aguardando os recursos
ativos. Se o processo for encerrado externamente, mensagens sem ACK podem ser
redeliveradas com segurança.

A fila de saída de eventos de integração não possui consumidor downstream
ativo ou definido; nenhum processo deste projeto lê ou exclui suas mensagens.
Sua DLQ configurada tampouco é monitorada nesta etapa. Testes do consumidor
criam banco PostgreSQL, fila FIFO e DLQ temporários exclusivos. Eles cobrem
commit atômico, rollback em falha, idempotência financeira separada da Inbox,
rejeição terminal, redelivery após falha de ACK, retry de falha transitória,
DLQ de mensagem inválida e encerramento do polling. `@aws-sdk/client-sqs` é
compartilhado pelo publisher e pelo consumidor.
