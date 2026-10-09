# Jungle Gaming — Distributed Wagering Processor

Aplicação do desafio descrito integralmente em [CHALLENGE.md](./CHALLENGE.md). Este README cobre setup, execução, testes e endpoints.

## Requisitos locais (Windows)

- Windows 10/11 com Docker Desktop em execução e integração WSL 2 habilitada.
- Bun 1.4.2 ou compatível com Bun 1.x.
- PowerShell e o plugin `docker compose` disponíveis no terminal do VS Code.
- Portas `5433` e `4566` livres. Se `5433` estiver ocupada, ajuste `DB_PORT` no `.env` e use a mesma porta em todos os comandos.

Não é necessário instalar PostgreSQL ou LocalStack diretamente no Windows: o Compose inicia os dois em containers. Os comandos abaixo podem ser executados no PowerShell, na raiz do repositório.

## Setup inicial

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
bun install
docker compose up -d postgres localstack
```

O `.env.example` usa credenciais locais de desenvolvimento e a porta `5433` para evitar conflito com uma instalação local comum do PostgreSQL na porta `5432`.

Confira o PostgreSQL e aplique as migrations:

```powershell
bun run db:check
bun run db:migrate
```

Na inicialização, a aplicação provisiona as filas FIFO `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo` no LocalStack.

## Executar a aplicação

```powershell
bun run start
```

Para desenvolvimento com reinício automático:

```powershell
bun run start:dev
```

O servidor escuta em `http://localhost:3000` por padrão. Altere `PORT` no `.env` se necessário. Liveness e readiness estão em `/health/live` e `/health/ready`; readiness verifica PostgreSQL e as filas SQS.

## Testes e verificações

Mantenha PostgreSQL e LocalStack ativos para executar a suíte completa. Os testes de integração usam instâncias reais em containers, com schemas temporários isolados:

```powershell
bun test
bun run typecheck
```

Os testes abrangem domínio financeiro, migrations/constraints, transações e ledger no PostgreSQL, concorrência com várias conexões e instâncias, processamento paralelo de wallets distintas, inbox/redelivery, recuperação após commit antes do ack e após reinício, publishers concorrentes, retry e DLQ no LocalStack SQS.

Para verificar apenas a conexão ou reaplicar migrations:

```powershell
bun run db:check
bun run db:migrate
```

## Endpoints

| Método | Rota | Uso |
|---|---|---|
| `POST` | `/wallets` | Cria wallet com saldo inicial decimal em string |
| `GET` | `/wallets/:walletId` | Consulta saldo e versão |
| `GET` | `/wallets/:walletId/ledger?limit=50&cursor=...` | Consulta lançamentos com cursor opaco |
| `POST` | `/wallets/:walletId/reconciliation` | Compara saldo materializado e saldo reconstruído do ledger |
| `POST` | `/wagering/transactions` | Submete aposta; exige `Idempotency-Key` |
| `GET` | `/wagering/transactions/:transactionId` | Consulta por ID interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta por referência externa |
| `GET` | `/health/live` | Verifica se o processo está ativo |
| `GET` | `/health/ready` | Verifica PostgreSQL e SQS |
| `GET` | `/metrics` | Expõe métricas Prometheus em processo |

Exemplo para criar uma wallet pelo PowerShell:

```powershell
$body = @{
  playerId = "player-123"
  initialBalance = @{ amount = "100.00"; currency = "BRL" }
} | ConvertTo-Json

$wallet = Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:3000/wallets `
  -ContentType "application/json" `
  -Body $body
```

Exemplo de submissão:

```powershell
$body = @{
  providerId = "provider-a"
  externalTransactionId = "transaction-123"
  playerId = $wallet.playerId
  walletId = $wallet.id
  roundId = "round-987"
  gameId = "fortune-chimp"
  kind = "BET"
  money = @{ amount = "25.00"; currency = "BRL" }
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:3000/wagering/transactions `
  -Headers @{ "Idempotency-Key" = "provider-a:transaction-123" } `
  -ContentType "application/json" `
  -Body $body
```

Respostas distinguem entrada inválida (`400`), wallet/transação não encontrada (`404`), conflito de idempotência (`409`), rejeição de regra de negócio (`422`), processamento pendente (`202`) e falha transitória de infraestrutura (`503`).

## Serviços locais

```powershell
docker compose ps
docker compose logs -f postgres
docker compose logs -f localstack
docker compose stop
```

`docker compose stop` preserva os dados. Não remova os volumes se quiser manter o banco e o estado local do LocalStack.

## Escopo e limitações deliberadas

O foco é o processamento financeiro, persistência transacional, idempotência, concorrência, ledger, inbox/outbox, SQS e API. Os diferenciais opcionais do desafio — autenticação, OpenTelemetry/dashboard, teste de carga e ledger de partidas dobradas — não foram implementados.

O outbox oferece publicação **at-least-once**: uma falha depois do envio ao SQS e antes de marcar a mensagem como publicada pode causar redelivery; o `eventId` estável permite que consumidores downstream façam deduplicação. O inbox protege a entrada SQS deste serviço. As métricas são mantidas em memória e reiniciam junto com o processo.
