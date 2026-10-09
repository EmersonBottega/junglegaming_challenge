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
