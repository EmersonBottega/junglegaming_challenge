# Arquitetura da aplicação

Este documento explica as decisões já tomadas durante o desenvolvimento do desafio.

## Escolhas feitas

### Ferramentas

Uso de Bun 1.x, TypeScript estrito e NestJS, conforme o README do desafio. Os testes unitários também rodam com o Bun.

Para persistência, escolhido: **MikroORM**.

### Persistência financeira e concorrência

O valor será guardado no banco como um número inteiro de centavos. Por exemplo, R$ 12,34 será armazenado como `1234`. A coluna PostgreSQL `BIGINT` guarda esse número inteiro sem arredondamentos, e a moeda fica em outra coluna. No restante do sistema, o valor continua sendo representado pela classe `Money`.

Essa forma corresponde ao que `Money` já faz e evita cálculos com números decimais aproximados. O banco tem um limite para esse número: até `9.223.372.036.854.775.807` centavos. Um valor maior não poderá ser salvo.

Cada operação que mudar o saldo será feita em uma transação do banco usando MikroORM. Isso significa que a mudança no saldo e seu lançamento no ledger serão salvos juntos: ou os dois são salvos, ou nenhum deles é.

Durante a operação, o banco bloqueará a wallet afetada até terminar. Assim, se duas operações tentarem usar o saldo da mesma wallet ao mesmo tempo, uma espera a outra terminar. Wallets diferentes continuam podendo ser processadas ao mesmo tempo.

O próprio banco também impedirá criar mais de uma wallet para o mesmo jogador e moeda, salvar um saldo negativo ou alterar e apagar lançamentos do ledger. Cada wallet também terá no máximo um lançamento para a mesma transação.

As transações serão guardadas em uma tabela própria. A chave de idempotência e o ID externo serão únicos dentro de cada provedor, para que provedores diferentes possam usar os mesmos valores sem conflito. As operações internas `OPENING` não terão dados de provedor. Cada transação terá seu saldo resultante registrado quando for processada; assim, uma repetição pode devolver o saldo daquela operação, mesmo que a wallet já tenha mudado depois. O ledger só aceitará lançamentos ligados a uma transação existente. Quando uma referência for resolvida, o banco também verificará que a transação referenciada pertence ao mesmo provedor, jogador, wallet, moeda e rodada.

`WalletRepository` abre e busca wallets no PostgreSQL. Ao abrir uma wallet com saldo positivo, grava a wallet, a transação interna `OPENING` e seu lançamento de crédito na mesma transação do banco. Com saldo zero, grava somente a wallet. Ao carregar uma wallet, converte os centavos do PostgreSQL de volta para `Money` sem passar por números de ponto flutuante.

`WagerTransactionRepository` grava e busca transações de provedores por ID interno, chave de idempotência ou ID externo. Ao salvar uma transação processada, também registra o saldo resultante daquela operação para que o chamador possa devolver a resposta original em um reenvio. O repositório aceita o `EntityManager` da transação chamadora nas operações de escrita, permitindo que a camada de aplicação coordene a transação da aposta com a wallet e o ledger.

`ProcessPersistedWagerTransaction` coordena `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` dentro de uma transação PostgreSQL. Primeiro serializa chamadas com a mesma chave de idempotência, depois bloqueia a wallet e grava a transação, o saldo (quando mudou) e o lançamento no ledger juntos. A chave de idempotência também serializa reenvios direcionados a wallets diferentes; o lock da wallet protege o saldo contra operações concorrentes. Para resolver referências, o serviço bloqueia a transação referenciada. Esse lock permite detectar e rejeitar um segundo `REFUND` ou `ROLLBACK` do mesmo tipo sem depender apenas de erro de constraint. Uma falha ao gravar qualquer parte desfaz todas as alterações. Chave igual com payload diferente é conflito; uma rejeição por regra de negócio é persistida e não cria lançamento.

O processador também cria eventos de integração dentro dessa mesma transação. Cada evento tem envelope versionado com `eventId`, `aggregateId`, `correlationId`, `causationId`, data ISO e dados JSON. `WagerTransactionProcessed` é criado para qualquer operação processada, inclusive `LOSS` e a transação interna `OPENING`; `WagerTransactionRejected` representa rejeições; `WagerTransactionPendingReference` registra referências ausentes; `WalletBalanceChanged` só é criado quando existe lançamento financeiro. O `OutboxRepository` grava esses envelopes em `outbox_message`, assim um rollback financeiro também desfaz os eventos ainda não publicados. `OutboxPublisher` reivindica linhas com `FOR UPDATE SKIP LOCKED` e lease persistente, publica em `wager-events.fifo` e agenda novas tentativas com backoff. Uma falha entre envio ao SQS e marcação no PostgreSQL pode duplicar a publicação; por isso a entrega é at-least-once e `eventId` permanece estável.

`WIN` credita a wallet e pode referenciar uma aposta processada. `LOSS` registra o resultado e o saldo observado, mas não atualiza a wallet nem cria lançamento. `REFUND` e `ROLLBACK` são processados somente quando sua referência existe e é válida; valores incorretos e referências incompatíveis são rejeitados. `ROLLBACK` inverte a direção original, e uma reversão que deixaria o saldo negativo é persistida com `REVERSAL_WOULD_OVERDRAW`. Operações com referência ainda ausente ficam em `PENDING_REFERENCE`; o worker e suas regras de retry estão descritos abaixo.

### Como o dinheiro é representado

As entradas e saídas usam strings decimais com duas casas, por exemplo `"25.00"`. Dentro do domínio, `Money` guarda o valor como centavos em `bigint`. Assim, uma soma ou subtração não depende de ponto flutuante e não sofre erros de arredondamento.

Entradas negativas, com formato inválido, notação científica ou mais de duas casas são rejeitadas. Uma operação interna pode produzir um valor negativo temporário, por exemplo ao calcular uma subtração, porém a wallet não deve aceitar uma movimentação que deixe seu saldo negativo.

O código de moeda é validado pela lista `Intl.supportedValuesOf("currency")` fornecida pelo Bun. Essa escolha evita uma dependência adicional.

### Wallet e ledger

O ledger é o histórico das movimentações de uma wallet. Cada débito ou crédito deve ter um lançamento que explique a diferença entre o saldo anterior e o posterior.

`WalletLedgerEntry` verifica essa conta ao ser criado e não pode ser alterado depois. A wallet atualiza o saldo somente depois que o lançamento correspondente foi criado.

O README exige que um saldo inicial positivo gere uma transação interna `OPENING` e um lançamento `CREDIT` correspondente no ledger. `Wallet.open` retorna a wallet e o lançamento, usando os IDs da transação e do lançamento fornecidos por quem a chama. `WalletRepository` persiste os três registros juntos. Com saldo zero, não há transação nem lançamento de abertura.

As datas são copiadas ao entrar e sair dos objetos, para que uma alteração feita por quem usa o objeto não modifique a data registrada.

### Transações de aposta

`WagerTransaction` representa as operações `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`, além da operação interna `OPENING`. Uma nova transação começa em `PENDING`. `REFUND` e `ROLLBACK` sempre precisam informar uma referência. `WIN` pode informar uma referência opcional a uma aposta. Se uma dessas referências informadas ainda não tiver sido resolvida, a transação pode ficar em `PENDING_REFERENCE`.

`PROCESSED`, `REJECTED` e `FAILED` são estados finais: a entidade não permite novas transições depois de alcançá-los. `REJECTED` registra uma rejeição por regra de negócio; `FAILED` é reservado a uma falha permanente de infraestrutura.

O tipo da operação determina a direção do lançamento: `BET` gera débito; `WIN`, `REFUND` e `OPENING` geram crédito; `LOSS` não movimenta o saldo nem gera lançamento. `WIN` pode referenciar uma aposta `BET` processada do mesmo provedor, jogador, wallet, rodada e moeda; o valor da aposta não precisa ser igual ao valor do prêmio. `REFUND` só aceita uma aposta `BET` processada, e `ROLLBACK` só aceita uma transação `BET`, `WIN` ou `REFUND` processada. Em `REFUND` e `ROLLBACK`, o valor deve ser igual ao da transação referenciada; `ROLLBACK` usa a direção inversa. As referências são identificadas pelo ID externo informado.

No processamento de `REFUND`, uma referência ausente ou ainda pendente deixa a operação em `PENDING_REFERENCE`. Uma referência incompatível ou já encerrada sem sucesso faz a operação ser rejeitada. Com uma aposta processada e compatível, a wallet recebe o crédito e o ledger registra o lançamento correspondente.

No processamento de `ROLLBACK`, a referência precisa ser uma transação `BET`, `WIN` ou `REFUND` processada, e o valor precisa ser igual ao valor referenciado. A operação inverte a direção original: por exemplo, desfazer um crédito gera um débito. Se esse débito deixaria a wallet com saldo negativo, o `ROLLBACK` é rejeitado com o código `REVERSAL_WOULD_OVERDRAW`, diferente da rejeição de uma aposta sem saldo.

`ReferenceRetryWorker` consulta referências pendentes no PostgreSQL, sem depender da memória do processo. O próximo horário de tentativa usa backoff exponencial limitado a 300 segundos. Depois de 12 tentativas ou 24 horas desde a criação, a transação é rejeitada com `REFERENCE_NOT_FOUND` e o evento correspondente é gravado no outbox, atomicamente.

### API e idempotência

`WagerTransactionRequest` é compartilhado pela API e pelo consumidor SQS. Ele valida os dados e calcula `payloadHash` como SHA-256 do JSON canônico dos campos de negócio (chaves ordenadas); a chave de idempotência e metadados de transporte não fazem parte do hash. A chave vem obrigatoriamente do header `Idempotency-Key` na API e é persistida no PostgreSQL.

A API expõe criação e leitura de wallets, submissão/consulta de transações, paginação estável do ledger e reconciliação. Os status distinguem entrada inválida (`400`), recurso ausente (`404`), conflito idempotente (`409`), rejeição de negócio (`422`), pendência aceita (`202`) e indisponibilidade transitória (`503`). A reconciliação compara a wallet com a soma assinada dos lançamentos e informa divergências; nunca corrige o saldo silenciosamente.

### SQS, inbox e ciclo de vida

`SqsQueues` cria/valida três filas FIFO locais: `wager-transactions.fifo` para entrada, `wager-transactions-dlq.fifo` para mensagens inválidas e `wager-events.fifo` para eventos publicados pelo outbox. A fila de eventos é separada da fila de comandos para o consumidor não tratar eventos de integração como novos pedidos de aposta.

`WagerConsumer` valida mensagens antes de processar, registra `(consumerName, messageId)` e seu hash na inbox e executa a inbox, a transação financeira e a gravação do outbox na mesma transação PostgreSQL. O ack/delete acontece somente depois do commit. Uma redelivery já processada é reconhecida pela inbox; payload diferente com o mesmo ID vai para a DLQ. Erros transitórios usam visibilidade crescente e a redrive policy da fila limita entregas. Em `SIGTERM`, o runtime interrompe polling e aguarda as tarefas em andamento antes de fechar SQS e PostgreSQL.

`/health/live` indica que o processo está vivo; `/health/ready` testa PostgreSQL e as três filas SQS. `/metrics` publica métricas Prometheus em memória: contagens por resultado, duplicatas, retries, DLQ, waits de lock, latência, outbox lag e divergências de reconciliação. Reiniciar o processo zera essas métricas operacionais.

### Escopo não implementado

Foram deixados de fora os diferenciais opcionais: autenticação, OpenTelemetry/dashboard, testes de carga e ledger de partidas dobradas. O enunciado completo está em [CHALLENGE.md](./CHALLENGE.md); instruções de execução estão no [README.md](./README.md).
