# Arquitetura da aplicação

Este documento explica as decisões já tomadas durante o desenvolvimento do desafio.

## Escolhas feitas

### Ferramentas

Uso de Bun 1.x, TypeScript estrito e NestJS, conforme o README do desafio. Os testes unitários também rodam com o Bun.

Para persistência, escolhido: **MikroORM**.

### Como o dinheiro é representado

As entradas e saídas usam strings decimais com duas casas, por exemplo `"25.00"`. Dentro do domínio, `Money` guarda o valor como centavos em `bigint`. Assim, uma soma ou subtração não depende de ponto flutuante e não sofre erros de arredondamento.

Entradas negativas, com formato inválido, notação científica ou mais de duas casas são rejeitadas. Uma operação interna pode produzir um valor negativo temporário, por exemplo ao calcular uma subtração, porém a wallet não deve aceitar uma movimentação que deixe seu saldo negativo.

O código de moeda é validado pela lista `Intl.supportedValuesOf("currency")` fornecida pelo Bun. Essa escolha evita uma dependência adicional.

### Wallet e ledger

O ledger é o histórico das movimentações de uma wallet. Cada débito ou crédito deve ter um lançamento que explique a diferença entre o saldo anterior e o posterior.

`WalletLedgerEntry` verifica essa conta ao ser criado e não pode ser alterado depois. A wallet atualiza o saldo somente depois que o lançamento correspondente foi criado.

O README exige que um saldo inicial positivo gere uma transação interna `OPENING` e um lançamento `CREDIT` correspondente no ledger. `Wallet.open` retorna a wallet e o lançamento, usando os IDs da transação e do lançamento fornecidos por quem a chama. A entidade `WagerTransaction` já representa os tipos e estados da transação, mas a abertura da wallet ainda não cria essa entidade. Com saldo zero, não há lançamento de abertura.

As datas são copiadas ao entrar e sair dos objetos, para que uma alteração feita por quem usa o objeto não modifique a data registrada.

### Transações de aposta

`WagerTransaction` representa as operações `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`, além da operação interna `OPENING`. Uma nova transação começa em `PENDING`. `REFUND` e `ROLLBACK` precisam informar a transação externa que estão referenciando, enquanto ela não for resolvida, a transação pode ficar em `PENDING_REFERENCE`.

`PROCESSED`, `REJECTED` e `FAILED` são estados finais: a entidade não permite novas transições depois de alcançá-los. `REJECTED` registra uma rejeição por regra de negócio; `FAILED` é reservado a uma falha permanente de infraestrutura.

O tipo da operação determina a direção do lançamento: `BET` gera débito; `WIN`, `REFUND` e `OPENING` geram crédito; `LOSS` não movimenta o saldo nem gera lançamento. `REFUND` só aceita uma aposta `BET` processada como referência. `ROLLBACK` só aceita uma transação `BET`, `WIN` ou `REFUND` processada, e usa a direção inversa. A referência precisa corresponder ao provedor, jogador, wallet, rodada, moeda, valor e ID externo informados.

A entidade valida uma reversão individual, mas ainda não impede que a mesma transação de referência seja revertida mais de uma vez.
