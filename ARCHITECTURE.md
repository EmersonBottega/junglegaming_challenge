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

O README exige que um saldo inicial positivo gere uma transação interna `OPENING` e um lançamento `CREDIT` correspondente no ledger. No domínio atual, `Wallet.open` retorna a wallet e esse lançamento, a entidade da transação ainda não está implementada. Com saldo zero, não há lançamento de abertura. Quem abre a wallet fornece os IDs da transação e do lançamento.

As datas são copiadas ao entrar e sair dos objetos, para que uma alteração feita por quem usa o objeto não modifique a data registrada.
