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
- `src/messaging/sqs/`: configuração do cliente SQS do publisher.
- `src/http/`: controller de `POST /wagering/transactions`, responsável pela
  validação de entrada e pelo mapeamento de erros para HTTP.
- `src/messaging/contracts/`: contratos versionados e validação de mensagens
  SQS de entrada e eventos de integração de saída; o consumidor e o
  processamento transacional da Inbox ainda não estão implementados.
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
7. Constrói os eventos de integração, valida cada um com
   `parseWagerIntegrationEvent()` e insere os registros Outbox pelo mesmo
   `EntityManager`, antes de a transação confirmar.

Uma falha na construção, validação ou inserção de evento propaga erro e reverte
também a transação financeira, carteira, ledger e snapshot. Replays e conflitos
retornam antes da criação dos eventos; por isso não acrescentam registros à
Outbox.

Cada operação persistida como `PROCESSED` gera `WagerTransactionProcessed`,
inclusive `LOSS`. Uma rejeição de negócio persistida gera
`WagerTransactionRejected`. `WalletBalanceChanged` é criado somente quando a
operação altera o saldo, com os valores anterior e posterior efetivos. Os IDs dos eventos são gerados uma vez para a operação e persistidos como
`event_id`; o publisher descrito abaixo reutiliza esse identificador em todas
as tentativas. O fluxo não garante entrega exactly-once.

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
default de banco; a semântica pretendida é inserir essa linha dentro da mesma
transação SQL que conclui a operação financeira. Ainda não existe código de
consumidor nem esse processamento transacional.

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
  para falhas inesperadas, após rollback. O controller valida os campos
  obrigatórios, `referenceExternalTransactionId` e o formato de `Money` antes
  de responder `501` para um `REFUND`/`ROLLBACK` válido; payload malformado
  permanece `400`.
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
Os testes de concorrência também iniciam três instâncias NestJS independentes,
com servidores e pools próprios, para verificar a serialização no PostgreSQL
compartilhado. A migration de snapshots foi testada para recusar reversão
quando há transações externas terminais e manter seus dados e sua aplicação.

Ainda previsto: endpoint de abertura e endpoints de consulta; `REFUND` e
`ROLLBACK`; referências pendentes; consumidor SQS, processamento transacional
da Inbox, retries de consumo e tratamento da DLQ; reconciliação, health checks,
observabilidade e autenticação opcional. O publisher Outbox é implementado
abaixo. Os testes ainda não validam execução em três ou mais processos do
sistema operacional para o publisher.

## Preparação de SQS e contratos da etapa 4

O README oficial determina AWS SQS via LocalStack ou MiniStack e pressupõe
entrega `at-least-once`, reentrega, eventos duplicados e indisponibilidade
temporária. Também define a estrutura conceitual de Inbox e Outbox e exige que
Inbox, operação financeira, ledger e Outbox participem da mesma transação SQL.
O enunciado não determina os nomes exatos das filas nem um envelope completo
de entrada/saída; os nomes e esquemas abaixo são decisões desta implementação,
não requisitos literais do README.

O serviço LocalStack usa container próprio no Docker Compose e porta local
`14566`, sem substituir nem compartilhar os recursos PostgreSQL do projeto.
Os nomes vêm das variáveis `SQS_WAGER_TRANSACTIONS_QUEUE` e
`SQS_WAGER_TRANSACTIONS_DLQ`, compartilhadas pelo serviço, script de
provisionamento e healthcheck; os defaults são `wager-transactions.fifo` e
`wager-transactions-dlq.fifo`. O provisionamento usa `create-queue` com os
mesmos atributos, podendo ser repetido sem criar filas duplicadas. A fila de
entrada tem redrive para a DLQ após cinco recebimentos sem confirmação. FIFO e
deduplicação do broker serão otimizações de ordenação e tráfego, não a
garantia de idempotência financeira.

A fila de saída `wager-integration-events.fifo` é provisionada separadamente
por `SQS_WAGER_INTEGRATION_EVENTS_QUEUE`; não compartilha a DLQ da fila de
entrada. O publisher usa `SQS_ENDPOINT` para LocalStack, `AWS_REGION` para a
região, credenciais locais fictícias quando há endpoint customizado e a cadeia
padrão do SDK para AWS.

A mensagem de entrada proposta tem `messageVersion: 1`, `idempotencyKey` e
`transaction`. O objeto de transação contém `providerId`,
`externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`
e `money`. A validação já implementada nesta subetapa aceita os tipos atuais
`BET`, `WIN` e `LOSS`, valida identificadores e Money sem conversão monetária
para `number`, e rejeita `OPENING`; `REFUND` e `ROLLBACK` ficam fora da etapa 4.
O `messageId` de transporte virá dos atributos do SQS; não substitui a
`idempotencyKey` de negócio.

Os eventos de saída definidos para operações atuais compartilham um envelope
com `eventId` criado uma vez e persistido com o evento na Outbox,
`eventType`, `eventVersion: 1`, `occurredAt` ISO-8601 UTC com sufixo `Z` e
precisão de até milissegundos, `aggregateId` (UUID da wallet), `payload` e
`causationId`/`correlationId` opcionais.
`WagerTransactionProcessed` inclui operações `LOSS`, `WagerTransactionRejected`
carrega `failureCode`, e `WalletBalanceChanged` só é emitido se o saldo mudar.
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

Ainda não há consumidor SQS, processamento da Inbox, confirmação/ack de
mensagens recebidas, retries de consumo ou tratamento operacional da DLQ de
entrada. A dependência `@aws-sdk/client-sqs` é usada pelo publisher.
